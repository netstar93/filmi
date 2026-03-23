import { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { storageService } from '../../../services/storageService';
import {
  TraktService,
  TraktWatchedItem,
} from '../../../services/traktService';
import { logger } from '../../../utils/logger';

import {
  CW_DEFAULT_DAYS_CAP,
  CW_HISTORY_MAX_PAGES,
  CW_HISTORY_PAGE_LIMIT,
  CW_MAX_DISPLAY_ITEMS,
  CW_MAX_NEXT_UP_LOOKUPS,
  CW_MAX_RECENT_PROGRESS_ITEMS,
  TRAKT_RECONCILE_COOLDOWN,
  TRAKT_SYNC_COOLDOWN,
} from './constants';
import { GetCachedMetadata, LocalProgressEntry } from './dataTypes';
import {
  filterRemovedItems,
  findNextEpisode,
  getHighestLocalMatch,
  getLocalMatches,
  getMostRecentLocalMatch,
} from './dataShared';
import { ContinueWatchingItem } from './types';

interface MergeTraktContinueWatchingParams {
  traktService: TraktService;
  getCachedMetadata: GetCachedMetadata;
  localProgressIndex: Map<string, LocalProgressEntry[]> | null;
  localWatchedShowsMapPromise: Promise<Map<string, number>>;
  recentlyRemoved: Set<string>;
  lastTraktSyncRef: MutableRefObject<number>;
  lastTraktReconcileRef: MutableRefObject<Map<string, number>>;
  setContinueWatchingItems: Dispatch<SetStateAction<ContinueWatchingItem[]>>;
}

// CHANGE: Added bulletproof time parser to prevent NaN from breaking sort algorithm.
// Previously used `new Date(value).getTime()` inline which could produce NaN and
// cause unpredictable sort order.
const getValidTime = (dateVal: any): number => {
  if (!dateVal) return 0;
  if (typeof dateVal === 'number') return isNaN(dateVal) ? 0 : dateVal;
  if (typeof dateVal === 'string') {
    const parsed = new Date(dateVal).getTime();
    return isNaN(parsed) ? 0 : parsed;
  }
  if (dateVal instanceof Date) {
    const parsed = dateVal.getTime();
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

export async function mergeTraktContinueWatching({
  traktService,
  getCachedMetadata,
  localProgressIndex,
  localWatchedShowsMapPromise,
  recentlyRemoved,
  lastTraktSyncRef,
  lastTraktReconcileRef,
  setContinueWatchingItems,
}: MergeTraktContinueWatchingParams): Promise<void> {

  // CHANGE: Added auth check at the top. If user is not authenticated,
  // clear the list immediately and return. The `await` is required —
  // without it isAuthenticated() returns a Promise (always truthy) and
  // the check never fires.
  if (!await traktService.isAuthenticated()) {
    setContinueWatchingItems([]);
    return;
  }

  const now = Date.now();
  if (
    TRAKT_SYNC_COOLDOWN > 0 &&
    now - lastTraktSyncRef.current < TRAKT_SYNC_COOLDOWN
  ) {
    logger.log(
      `[TraktSync] Skipping Trakt sync - cooldown active (${Math.round((TRAKT_SYNC_COOLDOWN - (now - lastTraktSyncRef.current)) / 1000)}s remaining)`
    );
    return;
  }

  lastTraktSyncRef.current = now;

  // ─── 1. Fetch all Trakt data sources (matching NuvioTV) ───
  let playbackItems: any[] = [];
  let watchedShowsData: TraktWatchedItem[] = [];
  let episodeHistoryItems: any[] = [];

  try {
    const [playbackResult, watchedResult] = await Promise.all([
      traktService.getPlaybackProgress(),
      traktService.getWatchedShows(),
    ]);
    playbackItems = playbackResult;
    watchedShowsData = watchedResult;
    logger.log(`[TraktCW] Fetched ${playbackItems?.length ?? 0} playback items, ${watchedShowsData?.length ?? 0} watched shows`);
  } catch (err) {
    logger.warn('[TraktSync] API failed (likely disconnected or expired token):', err);
    setContinueWatchingItems([]);
    return;
  }

  // Fetch episode history (matching NuvioTV's fetchRecentEpisodeHistorySnapshot)
  try {
    const historyResults: any[] = [];
    const seenContentIds = new Set<string>();
    for (let page = 1; page <= CW_HISTORY_MAX_PAGES; page++) {
      const pageItems = await traktService.getWatchedEpisodesHistory(page, CW_HISTORY_PAGE_LIMIT);
      if (!pageItems || pageItems.length === 0) break;

      for (const item of pageItems) {
        const showImdb = item.show?.ids?.imdb;
        if (!showImdb) continue;
        const normalizedId = showImdb.startsWith('tt') ? showImdb : `tt${showImdb}`;
        // NuvioTV deduplicates by contentId (one per show), keeping the most recent
        if (seenContentIds.has(normalizedId)) continue;
        seenContentIds.add(normalizedId);
        historyResults.push(item);
        if (historyResults.length >= CW_MAX_RECENT_PROGRESS_ITEMS) break;
      }

      if (historyResults.length >= CW_MAX_RECENT_PROGRESS_ITEMS) break;
      if (pageItems.length < CW_HISTORY_PAGE_LIMIT) break;
    }
    episodeHistoryItems = historyResults;
    logger.log(`[TraktCW] Fetched ${episodeHistoryItems.length} episode history items (unique shows)`);
  } catch (err) {
    logger.warn('[TraktSync] Failed to fetch episode history:', err);
  }

  // ─── 2. Build watched episode sets per show ───
  const watchedEpisodeSetByShow = new Map<string, Set<string>>();

  try {
    for (const watchedShow of watchedShowsData) {
      if (!watchedShow.show?.ids?.imdb) continue;

      const imdb = watchedShow.show.ids.imdb.startsWith('tt')
        ? watchedShow.show.ids.imdb
        : `tt${watchedShow.show.ids.imdb}`;

      const resetAt = getValidTime(watchedShow.reset_at);
      const episodeSet = new Set<string>();

      if (watchedShow.seasons) {
        for (const season of watchedShow.seasons) {
          for (const episode of season.episodes) {
            if (resetAt > 0) {
              const watchedAt = getValidTime(episode.last_watched_at);
              if (watchedAt < resetAt) continue;
            }
            episodeSet.add(`${imdb}:${season.number}:${episode.number}`);
          }
        }
      }
      watchedEpisodeSetByShow.set(imdb, episodeSet);
    }
  } catch (err) {
    logger.warn('[TraktSync] Error mapping watched shows:', err);
  }

  // ─── 3. Merge sources: history first, then playback overwrites (matching NuvioTV) ───
  // NuvioTV merges in order: recentCompletedEpisodes → (inProgressMovies + inProgressEpisodes)
  // Later entries overwrite earlier ones by key, so playback (in-progress) takes priority.

  const daysCutoff = Date.now() - (CW_DEFAULT_DAYS_CAP * 24 * 60 * 60 * 1000);

  // Internal progress items keyed by "type:contentId" for series or "type:contentId" for movies
  interface ProgressEntry {
    contentId: string;
    contentType: 'movie' | 'series';
    season?: number;
    episode?: number;
    episodeTitle?: string;
    progressPercent: number; // 0-100
    lastWatched: number;
    source: 'playback' | 'history' | 'watched_show';
    traktPlaybackId?: number;
  }

  const mergedByKey = new Map<string, ProgressEntry>();

  // 3a. Episode history items (completed episodes) — go in first, can be overwritten by playback
  for (const item of episodeHistoryItems) {
    try {
      const show = item.show;
      const episode = item.episode;
      if (!show?.ids?.imdb || !episode) continue;

      const showImdb = show.ids.imdb.startsWith('tt')
        ? show.ids.imdb
        : `tt${show.ids.imdb}`;
      const lastWatched = getValidTime(item.watched_at);
      if (lastWatched > 0 && lastWatched < daysCutoff) continue;

      const key = showImdb; // NuvioTV uses contentId as key (one per show)
      mergedByKey.set(key, {
        contentId: showImdb,
        contentType: 'series',
        season: episode.season,
        episode: episode.number,
        episodeTitle: episode.title,
        progressPercent: 100, // Completed
        lastWatched,
        source: 'history',
      });
    } catch {
      // Skip bad items
    }
  }

  // 3b. Playback items (in-progress) — overwrite history entries for the same content
  const sortedPlaybackItems = [...(playbackItems || [])]
    .sort((a, b) => {
      const timeA = getValidTime(a.paused_at || a.updated_at || a.last_watched_at);
      const timeB = getValidTime(b.paused_at || b.updated_at || b.last_watched_at);
      return timeB - timeA;
    })
    .slice(0, CW_MAX_RECENT_PROGRESS_ITEMS);

  for (const item of sortedPlaybackItems) {
    try {
      if (item.progress < 2) continue;

      const pausedAt = getValidTime(item.paused_at || item.updated_at);
      if (pausedAt > 0 && pausedAt < daysCutoff) continue;

      if (item.type === 'movie' && item.movie?.ids?.imdb) {
        const imdbId = item.movie.ids.imdb.startsWith('tt')
          ? item.movie.ids.imdb
          : `tt${item.movie.ids.imdb}`;

        const key = imdbId;
        mergedByKey.set(key, {
          contentId: imdbId,
          contentType: 'movie',
          progressPercent: item.progress,
          lastWatched: pausedAt,
          source: 'playback',
          traktPlaybackId: item.id,
        });
      } else if (item.type === 'episode' && item.show?.ids?.imdb && item.episode) {
        const showImdb = item.show.ids.imdb.startsWith('tt')
          ? item.show.ids.imdb
          : `tt${item.show.ids.imdb}`;

        const key = showImdb;
        mergedByKey.set(key, {
          contentId: showImdb,
          contentType: 'series',
          season: item.episode.season,
          episode: item.episode.number,
          episodeTitle: item.episode.title,
          progressPercent: item.progress,
          lastWatched: pausedAt,
          source: 'playback',
          traktPlaybackId: item.id,
        });
      }
    } catch {
      // Continue with remaining playback items.
    }
  }

  // ─── 4. Sort merged items by lastWatched and apply cap ───
  const allMerged = Array.from(mergedByKey.values())
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .slice(0, CW_MAX_RECENT_PROGRESS_ITEMS);

  logger.log(`[TraktCW] Merged ${allMerged.length} items (history→playback). Breakdown: ${allMerged.filter(e => e.source === 'history').length} history, ${allMerged.filter(e => e.source === 'playback').length} playback`);
  for (const entry of allMerged.slice(0, 15)) {
    logger.log(`[TraktCW]   ${entry.contentType} ${entry.contentId} S${entry.season ?? '-'}E${entry.episode ?? '-'} progress=${entry.progressPercent.toFixed(1)}% src=${entry.source} last=${new Date(entry.lastWatched).toISOString()}`);
  }
  if (allMerged.length > 15) logger.log(`[TraktCW]   ... and ${allMerged.length - 15} more`);

  // ─── 5. Separate in-progress items vs completed seeds (matching NuvioTV pipeline) ───
  // In-progress: 2% ≤ progress < 85%
  // Completed seed: progress ≥ 85% (will be used for Up Next)
  const inProgressEntries: ProgressEntry[] = [];
  const completedSeeds: ProgressEntry[] = [];

  for (const entry of allMerged) {
    if (entry.progressPercent >= 2 && entry.progressPercent < 85) {
      inProgressEntries.push(entry);
    } else if (entry.progressPercent >= 85) {
      completedSeeds.push(entry);
    }
  }

  logger.log(`[TraktCW] Separated: ${inProgressEntries.length} in-progress (2-85%), ${completedSeeds.length} completed seeds (≥85%)`);

  // ─── 6. Episode deduplication for in-progress (matching NuvioTV deduplicateInProgress) ───
  // For series: only keep the latest-watched episode per series
  const dedupedInProgress: ProgressEntry[] = [];
  const seriesLatest = new Map<string, ProgressEntry>();

  for (const entry of inProgressEntries) {
    if (entry.contentType === 'series') {
      const existing = seriesLatest.get(entry.contentId);
      if (!existing || entry.lastWatched > existing.lastWatched) {
        seriesLatest.set(entry.contentId, entry);
      }
    } else {
      dedupedInProgress.push(entry);
    }
  }
  dedupedInProgress.push(...seriesLatest.values());
  dedupedInProgress.sort((a, b) => b.lastWatched - a.lastWatched);

  logger.log(`[TraktCW] After series dedup: ${dedupedInProgress.length} in-progress items (was ${inProgressEntries.length})`);
  for (const entry of dedupedInProgress) {
    logger.log(`[TraktCW]   IN-PROGRESS: ${entry.contentType} ${entry.contentId} S${entry.season ?? '-'}E${entry.episode ?? '-'} progress=${entry.progressPercent.toFixed(1)}% last=${new Date(entry.lastWatched).toISOString()}`);
  }

  // ─── 7. Build in-progress ContinueWatchingItems ───
  const traktBatch: ContinueWatchingItem[] = [];
  const inProgressSeriesIds = new Set<string>();

  for (const entry of dedupedInProgress) {
    if (recentlyRemoved.has(`${entry.contentType}:${entry.contentId}`)) continue;

    const type = entry.contentType === 'movie' ? 'movie' : 'series';
    const cachedData = await getCachedMetadata(type, entry.contentId);
    if (!cachedData?.basicContent) continue;

    if (entry.contentType === 'series') {
      inProgressSeriesIds.add(entry.contentId);
    }

    traktBatch.push({
      ...cachedData.basicContent,
      id: entry.contentId,
      type: type,
      progress: entry.progressPercent,
      lastUpdated: entry.lastWatched,
      season: entry.season,
      episode: entry.episode,
      episodeTitle: entry.episodeTitle || (entry.episode ? `Episode ${entry.episode}` : undefined),
      addonId: undefined,
      traktPlaybackId: entry.traktPlaybackId,
    } as ContinueWatchingItem);
  }

  logger.log(`[TraktCW] Built ${traktBatch.length} in-progress CW items. Suppressed series IDs: [${Array.from(inProgressSeriesIds).join(', ')}]`);

  // ─── 8. Build Up Next items from completed seeds (matching NuvioTV buildLightweightNextUpItems) ───
  // Completed seeds from playback + history: find next episode for each
  const nextUpSeeds: ProgressEntry[] = [];

  // Add completed entries from merged data
  for (const entry of completedSeeds) {
    if (entry.contentType !== 'series') continue;
    if (inProgressSeriesIds.has(entry.contentId)) continue; // Next-up suppression
    if (recentlyRemoved.has(`series:${entry.contentId}`)) continue;
    nextUpSeeds.push(entry);
  }

  // ─── 9. Add watched show seeds (matching NuvioTV observeWatchedShowSeeds) ───
  try {
    const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);
    const sortedWatchedShows = [...(watchedShowsData || [])]
      .filter((show) => {
        const watchedAt = getValidTime(show.last_watched_at);
        return watchedAt > sixMonthsAgo;
      })
      .sort((a, b) => {
        const timeA = getValidTime(a.last_watched_at);
        const timeB = getValidTime(b.last_watched_at);
        return timeB - timeA;
      });

    for (const watchedShow of sortedWatchedShows) {
      try {
        if (!watchedShow.show?.ids?.imdb) continue;

        const showImdb = watchedShow.show.ids.imdb.startsWith('tt')
          ? watchedShow.show.ids.imdb
          : `tt${watchedShow.show.ids.imdb}`;

        // Skip if already in in-progress (next-up suppression)
        if (inProgressSeriesIds.has(showImdb)) continue;
        if (recentlyRemoved.has(`series:${showImdb}`)) continue;

        // Skip if we already have a seed for this show (from playback/history)
        if (nextUpSeeds.some(s => s.contentId === showImdb)) continue;

        const resetAt = getValidTime(watchedShow.reset_at);
        let lastWatchedSeason = 0;
        let lastWatchedEpisode = 0;
        let latestEpisodeTimestamp = 0;

        if (watchedShow.seasons) {
          for (const season of watchedShow.seasons) {
            for (const episode of season.episodes) {
              const episodeTimestamp = getValidTime(episode.last_watched_at);
              if (resetAt > 0 && episodeTimestamp < resetAt) continue;

              if (episodeTimestamp > latestEpisodeTimestamp) {
                latestEpisodeTimestamp = episodeTimestamp;
                lastWatchedSeason = season.number;
                lastWatchedEpisode = episode.number;
              }
            }
          }
        }

        if (lastWatchedSeason === 0 && lastWatchedEpisode === 0) continue;

        nextUpSeeds.push({
          contentId: showImdb,
          contentType: 'series',
          season: lastWatchedSeason,
          episode: lastWatchedEpisode,
          progressPercent: 100,
          lastWatched: latestEpisodeTimestamp,
          source: 'watched_show',
        });
      } catch {
        // Continue with remaining watched shows.
      }
    }
  } catch (err) {
    logger.warn('[TraktSync] Error processing watched shows for Up Next:', err);
  }

  // ─── 10. Choose preferred seed per show (matching NuvioTV choosePreferredNextUpSeed) ───
  // Source ranking: playback (0) > history (1) > watched_show (2)
  const seedSourceRank = (source: string): number => {
    switch (source) {
      case 'playback': return 0;
      case 'history': return 1;
      case 'watched_show': return 2;
      default: return 4;
    }
  };

  const seedsByShow = new Map<string, ProgressEntry[]>();
  for (const seed of nextUpSeeds) {
    const existing = seedsByShow.get(seed.contentId) || [];
    existing.push(seed);
    seedsByShow.set(seed.contentId, existing);
  }

  const bestSeeds: ProgressEntry[] = [];
  for (const [, seeds] of seedsByShow) {
    const bestRank = Math.min(...seeds.map(s => seedSourceRank(s.source)));
    const bestRanked = seeds.filter(s => seedSourceRank(s.source) === bestRank);
    // Among same-rank seeds, pick highest season/episode, then most recent
    bestRanked.sort((a, b) => {
      if ((a.season ?? -1) !== (b.season ?? -1)) return (b.season ?? -1) - (a.season ?? -1);
      if ((a.episode ?? -1) !== (b.episode ?? -1)) return (b.episode ?? -1) - (a.episode ?? -1);
      return b.lastWatched - a.lastWatched;
    });
    if (bestRanked.length > 0) bestSeeds.push(bestRanked[0]);
  }

  // Sort by lastWatched and limit to CW_MAX_NEXT_UP_LOOKUPS (24)
  bestSeeds.sort((a, b) => b.lastWatched - a.lastWatched);
  const topSeeds = bestSeeds.slice(0, CW_MAX_NEXT_UP_LOOKUPS);

  logger.log(`[TraktCW] Up Next seeds: ${nextUpSeeds.length} total → ${bestSeeds.length} deduped → ${topSeeds.length} top seeds`);
  for (const seed of topSeeds) {
    logger.log(`[TraktCW]   SEED: ${seed.contentId} S${seed.season}E${seed.episode} src=${seed.source} rank=${seedSourceRank(seed.source)} last=${new Date(seed.lastWatched).toISOString()}`);
  }

  // ─── 11. Resolve next episodes for each seed ───
  const localWatchedMap = await localWatchedShowsMapPromise;

  for (const seed of topSeeds) {
    try {
      if (!seed.season || !seed.episode) continue;

      const cachedData = await getCachedMetadata('series', seed.contentId);
      if (!cachedData?.basicContent || !cachedData.metadata?.videos) continue;

      const watchedEpisodeSet = watchedEpisodeSetByShow.get(seed.contentId) ?? new Set<string>();
      const nextEpisodeResult = findNextEpisode(
        seed.season,
        seed.episode,
        cachedData.metadata.videos,
        watchedEpisodeSet,
        seed.contentId,
        localWatchedMap,
        seed.lastWatched,
        true // showUnairedNextUp
      );

      if (nextEpisodeResult) {
        const nextEpisode = nextEpisodeResult.video;
        logger.log(`[TraktCW]   UP-NEXT RESOLVED: ${seed.contentId} seed=S${seed.season}E${seed.episode} → next=S${nextEpisode.season}E${nextEpisode.episode} "${nextEpisode.title || ''}" last=${new Date(seed.lastWatched).toISOString()}`);
        traktBatch.push({
          ...cachedData.basicContent,
          id: seed.contentId,
          type: 'series',
          progress: 0,
          lastUpdated: seed.lastWatched,
          season: nextEpisode.season,
          episode: nextEpisode.episode,
          episodeTitle: nextEpisode.title || `Episode ${nextEpisode.episode}`,
          addonId: undefined,
          traktPlaybackId: seed.traktPlaybackId,
        } as ContinueWatchingItem);
      } else {
        logger.log(`[TraktCW]   UP-NEXT DROPPED: ${seed.contentId} seed=S${seed.season}E${seed.episode} — no next episode found (no videos or all watched)`);
      }
    } catch (err) {
      logger.warn(`[TraktCW]   UP-NEXT ERROR: ${seed.contentId}`, err);
    }
  }

  // ─── 12. Final dedup, reconcile, and sort ───
  logger.log(`[TraktCW] Pre-dedup batch: ${traktBatch.length} items (${traktBatch.filter(i => (i.progress ?? 0) > 0).length} in-progress + ${traktBatch.filter(i => (i.progress ?? 0) === 0).length} up-next)`);

  if (traktBatch.length === 0) {
    logger.log('[TraktCW] No items — clearing continue watching list');
    setContinueWatchingItems([]);
    return;
  }

  // Deduplicate: for same content, prefer items with progress > 0 (in-progress over up-next)
  const deduped = new Map<string, ContinueWatchingItem>();
  for (const item of traktBatch) {
    const key = `${item.type}:${item.id}`;
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, item);
      continue;
    }

    const existingHasProgress = (existing.progress ?? 0) > 0;
    const candidateHasProgress = (item.progress ?? 0) > 0;

    const safeItemTs = getValidTime(item.lastUpdated);
    const safeExistingTs = getValidTime(existing.lastUpdated);

    if (candidateHasProgress && !existingHasProgress) {
      const mergedTs = Math.max(safeItemTs, safeExistingTs);
      deduped.set(
        key,
        mergedTs !== safeItemTs
          ? { ...item, lastUpdated: mergedTs }
          : item
      );
    } else if (!candidateHasProgress && existingHasProgress) {
      if (safeItemTs > safeExistingTs) {
        deduped.set(key, { ...existing, lastUpdated: safeItemTs });
      }
    } else if (safeItemTs > safeExistingTs) {
      deduped.set(key, item);
    }
  }

  const filteredItems = await filterRemovedItems(Array.from(deduped.values()), recentlyRemoved);
  const reconcileLocalPromises: Promise<any>[] = [];

  const adjustedItems = filteredItems
    .map((item) => {
      const matches = getLocalMatches(item, localProgressIndex);
      if (matches.length === 0) return item;

      const mostRecentLocal = getMostRecentLocalMatch(matches);
      const highestLocal = getHighestLocalMatch(matches);

      if (!mostRecentLocal || !highestLocal) {
        return item;
      }

      // Use getValidTime for safe timestamp extraction
      const safeLocalTs = getValidTime(mostRecentLocal.lastUpdated);
      const safeItemTs = getValidTime(item.lastUpdated);

      const localProgress = mostRecentLocal.progressPercent;
      const traktProgress = item.progress ?? 0;
      const traktTs = safeItemTs;
      const localTs = safeLocalTs;

      const isAhead = isFinite(localProgress) && localProgress > traktProgress + 0.5;
      const isLocalNewer = localTs > traktTs + 5000;
      const isLocalRecent = localTs > 0 && Date.now() - localTs < 5 * 60 * 1000;
      const isDifferent = Math.abs((localProgress || 0) - (traktProgress || 0)) > 0.5;
      const isTraktAhead = isFinite(traktProgress) && traktProgress > localProgress + 0.5;

      if (isTraktAhead && !isLocalRecent && mostRecentLocal.duration > 0) {
        const reconcileKey = `local:${item.type}:${item.id}:${item.season ?? ''}:${item.episode ?? ''}`;
        const last = lastTraktReconcileRef.current.get(reconcileKey) ?? 0;
        const now = Date.now();

        if (now - last >= TRAKT_RECONCILE_COOLDOWN) {
          lastTraktReconcileRef.current.set(reconcileKey, now);

          const targetEpisodeId =
            item.type === 'series'
              ? mostRecentLocal.episodeId ||
                (item.season && item.episode
                  ? `${item.id}:${item.season}:${item.episode}`
                  : undefined)
              : undefined;

          const newCurrentTime = (traktProgress / 100) * mostRecentLocal.duration;

          reconcileLocalPromises.push(
            (async () => {
              try {
                const existing = await storageService.getWatchProgress(
                  item.id,
                  item.type,
                  targetEpisodeId
                );

                if (!existing || !existing.duration || existing.duration <= 0) {
                  return;
                }

                await storageService.setWatchProgress(
                  item.id,
                  item.type,
                  {
                    ...existing,
                    currentTime: Math.max(existing.currentTime ?? 0, newCurrentTime),
                    duration: existing.duration,
                    traktSynced: true,
                    traktLastSynced: Date.now(),
                    traktProgress: Math.max(existing.traktProgress ?? 0, traktProgress),
                    lastUpdated: existing.lastUpdated,
                  } as any,
                  targetEpisodeId,
                  { preserveTimestamp: true, forceWrite: true }
                );
              } catch {
                // Ignore background sync failures.
              }
            })()
          );
        }
      }

      // If Trakt says in-progress (2-85%) but local says completed (>=85%),
      // trust Trakt's playback endpoint — it's authoritative for paused items.
      const traktIsInProgress = traktProgress >= 2 && traktProgress < 85;
      const localSaysCompleted = localProgress >= 85;
      if (traktIsInProgress && localSaysCompleted) {
        return {
          ...item,
          lastUpdated: safeItemTs,
        };
      }

      if (((isLocalNewer || isLocalRecent) && isDifferent) || isAhead) {
        return {
          ...item,
          progress: localProgress,
          lastUpdated: safeItemTs, // keep Trakt timestamp, only update progress
        };
      }

      return {
        ...item,
        lastUpdated: safeItemTs, // keep Trakt timestamp for sort stability
      };
    });

  const finalItems = adjustedItems
    .sort((a, b) => getValidTime(b.lastUpdated) - getValidTime(a.lastUpdated))
    .slice(0, CW_MAX_DISPLAY_ITEMS);

  logger.log(`[TraktCW] ═══ FINAL LIST: ${finalItems.length} items (capped at ${CW_MAX_DISPLAY_ITEMS}) ═══`);
  for (let i = 0; i < finalItems.length; i++) {
    const item = finalItems[i];
    const isUpNext = (item.progress ?? 0) === 0 && item.type === 'series';
    const tag = isUpNext ? 'UP-NEXT' : 'RESUME';
    const epLabel = item.type === 'series' ? ` S${item.season ?? '?'}E${item.episode ?? '?'}` : '';
    const ts = getValidTime(item.lastUpdated);
    logger.log(`[TraktCW]   #${i + 1} [${tag}] ${item.name || item.id}${epLabel} — ${item.type} progress=${(item.progress ?? 0).toFixed(1)}% last=${ts ? new Date(ts).toISOString() : 'N/A'}`);
  }
  logger.log(`[TraktCW] ═══ END FINAL LIST ═══`);

  setContinueWatchingItems(finalItems);

  if (reconcileLocalPromises.length > 0) {
    Promise.allSettled(reconcileLocalPromises).catch(() => null);
  }
}