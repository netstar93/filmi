import { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { storageService } from '../../../services/storageService';
import {
  TraktService,
  TraktWatchedItem,
} from '../../../services/traktService';
import { logger } from '../../../utils/logger';

import { TRAKT_RECONCILE_COOLDOWN, TRAKT_SYNC_COOLDOWN } from './constants';
import { GetCachedMetadata, LocalProgressEntry } from './dataTypes';
import {
  // CHANGE: removed unused buildTraktContentData import
  filterRemovedItems,
  findNextEpisode,
  getHighestLocalMatch,
  getLocalMatches,
  getMostRecentLocalMatch,
} from './dataShared';
import { ContinueWatchingItem } from './types';
// CHANGE: removed unused compareContinueWatchingItems import (final sort now inline)

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
  const traktBatch: ContinueWatchingItem[] = [];

  // CHANGE: Moved API calls into a try/catch so that a failed/expired token
  // clears the list instead of leaving stale items on screen.
  let playbackItems: any[] = [];
  let watchedShowsData: TraktWatchedItem[] = [];

  try {
    playbackItems = await traktService.getPlaybackProgress();
    watchedShowsData = await traktService.getWatchedShows();
  } catch (err) {
    logger.warn('[TraktSync] API failed (likely disconnected or expired token):', err);
    setContinueWatchingItems([]);
    return;
  }

  const watchedEpisodeSetByShow = new Map<string, Set<string>>();

  try {
    for (const watchedShow of watchedShowsData) {
      if (!watchedShow.show?.ids?.imdb) continue;

      const imdb = watchedShow.show.ids.imdb.startsWith('tt')
        ? watchedShow.show.ids.imdb
        : `tt${watchedShow.show.ids.imdb}`;

      // CHANGE: Use getValidTime instead of `new Date(...).getTime()`
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

  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

  // CHANGE: Simplified sort — removed the +1000000000 "new episode priority boost"
  // that was added by a previous AI suggestion. That boost caused recently aired
  // episodes to incorrectly sort above items the user actually paused recently,
  // breaking the expected Trakt continue watching order on initial login.
  // Now sorts purely by most recent timestamp, newest first.
  const sortedPlaybackItems = [...(playbackItems || [])]
    .sort((a, b) => {
      const timeA = getValidTime(a.paused_at || a.updated_at || a.last_watched_at);
      const timeB = getValidTime(b.paused_at || b.updated_at || b.last_watched_at);
      return timeB - timeA;
    })
    .slice(0, 30);

  for (const item of sortedPlaybackItems) {
    try {
      if (item.progress < 2) continue;

      // CHANGE: Use getValidTime with fallback to updated_at for items missing paused_at
      const pausedAt = getValidTime(item.paused_at || item.updated_at);

      // CHANGE: Guard against items where pausedAt resolved to 0 (missing/invalid date)
      if (pausedAt > 0 && pausedAt < thirtyDaysAgo) continue;

      if (item.type === 'movie' && item.movie?.ids?.imdb) {
        if (item.progress >= 85) continue;

        const imdbId = item.movie.ids.imdb.startsWith('tt')
          ? item.movie.ids.imdb
          : `tt${item.movie.ids.imdb}`;

        if (recentlyRemoved.has(`movie:${imdbId}`)) continue;

        const cachedData = await getCachedMetadata('movie', imdbId);
        if (!cachedData?.basicContent) continue;

        traktBatch.push({
          ...cachedData.basicContent,
          id: imdbId,
          type: 'movie',
          progress: item.progress,
          lastUpdated: pausedAt,
          addonId: undefined,
          traktPlaybackId: item.id,
        } as ContinueWatchingItem);
      } else if (item.type === 'episode' && item.show?.ids?.imdb && item.episode) {
        const showImdb = item.show.ids.imdb.startsWith('tt')
          ? item.show.ids.imdb
          : `tt${item.show.ids.imdb}`;

        if (recentlyRemoved.has(`series:${showImdb}`)) continue;

        const cachedData = await getCachedMetadata('series', showImdb);
        if (!cachedData?.basicContent) continue;

        if (item.progress >= 85) {
          if (cachedData.metadata?.videos) {
            const watchedSetForShow = watchedEpisodeSetByShow.get(showImdb);
            const localWatchedMap = await localWatchedShowsMapPromise;
            const nextEpisodeResult = findNextEpisode(
              item.episode.season,
              item.episode.number,
              cachedData.metadata.videos,
              watchedSetForShow,
              showImdb,
              localWatchedMap,
              pausedAt
            );

            if (nextEpisodeResult) {
              const nextEpisode = nextEpisodeResult.video;
              traktBatch.push({
                ...cachedData.basicContent,
                id: showImdb,
                type: 'series',
                progress: 0,
                // CHANGE: Use pausedAt (from playback item) instead of
                // nextEpisodeResult.lastWatched so sort order stays consistent
                // with when the user actually paused, not local watch timestamps.
                lastUpdated: pausedAt,
                season: nextEpisode.season,
                episode: nextEpisode.episode,
                episodeTitle: nextEpisode.title || `Episode ${nextEpisode.episode}`,
                addonId: undefined,
                traktPlaybackId: item.id,
              } as ContinueWatchingItem);
            }
          }
          continue;
        }

        traktBatch.push({
          ...cachedData.basicContent,
          id: showImdb,
          type: 'series',
          progress: item.progress,
          lastUpdated: pausedAt,
          season: item.episode.season,
          episode: item.episode.number,
          episodeTitle: item.episode.title || `Episode ${item.episode.number}`,
          addonId: undefined,
          traktPlaybackId: item.id,
        } as ContinueWatchingItem);
      }
    } catch {
      // Continue with remaining playback items.
    }
  }

  try {
    // CHANGE: Extended window from 30 days to 6 months for watched shows
    // so up next items from less frequent viewing aren't excluded.
    const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);

    // CHANGE: Pre-sort and slice watched shows by recency before processing,
    // so the most recently watched shows are processed first and up next items
    // sort correctly alongside playback items.
    const sortedWatchedShows = [...(watchedShowsData || [])]
      .filter((show) => {
        const watchedAt = getValidTime(show.last_watched_at);
        return watchedAt > sixMonthsAgo;
      })
      .sort((a, b) => {
        const timeA = getValidTime(a.last_watched_at);
        const timeB = getValidTime(b.last_watched_at);
        return timeB - timeA;
      })
      .slice(0, 30);

    for (const watchedShow of sortedWatchedShows) {
      try {
        if (!watchedShow.show?.ids?.imdb) continue;

        const showImdb = watchedShow.show.ids.imdb.startsWith('tt')
          ? watchedShow.show.ids.imdb
          : `tt${watchedShow.show.ids.imdb}`;

        if (recentlyRemoved.has(`series:${showImdb}`)) continue;

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

        const cachedData = await getCachedMetadata('series', showImdb);
        if (!cachedData?.basicContent || !cachedData.metadata?.videos) continue;

        const watchedEpisodeSet = watchedEpisodeSetByShow.get(showImdb) ?? new Set<string>();
        const localWatchedMap = await localWatchedShowsMapPromise;
        const nextEpisodeResult = findNextEpisode(
          lastWatchedSeason,
          lastWatchedEpisode,
          cachedData.metadata.videos,
          watchedEpisodeSet,
          showImdb,
          localWatchedMap,
          latestEpisodeTimestamp
        );

        if (nextEpisodeResult) {
          const nextEpisode = nextEpisodeResult.video;
          traktBatch.push({
            ...cachedData.basicContent,
            id: showImdb,
            type: 'series',
            progress: 0,
            // CHANGE: Use latestEpisodeTimestamp directly (when user finished the
            // last episode) so up next items sort by actual watch recency.
            lastUpdated: latestEpisodeTimestamp,
            season: nextEpisode.season,
            episode: nextEpisode.episode,
            episodeTitle: nextEpisode.title || `Episode ${nextEpisode.episode}`,
            addonId: undefined,
          } as ContinueWatchingItem);
        }
      } catch {
        // Continue with remaining watched shows.
      }
    }
  } catch (err) {
    logger.warn('[TraktSync] Error processing watched shows for Up Next:', err);
  }

  // CHANGE: Clear list on empty batch instead of silently returning.
  // Previously `return` here left stale items on screen when Trakt returned
  // nothing (e.g. fresh login or just after disconnect).
  if (traktBatch.length === 0) {
    setContinueWatchingItems([]);
    return;
  }

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

    // CHANGE: Use getValidTime for safe timestamp comparison in dedup logic
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
  // CHANGE: Removed reconcilePromises (Trakt back-sync) — that logic was pushing
  // local progress back to Trakt which is out of scope for continue watching display.

  const adjustedItems = filteredItems
    .map((item) => {
      const matches = getLocalMatches(item, localProgressIndex);
      if (matches.length === 0) return item;

      const mostRecentLocal = getMostRecentLocalMatch(matches);
      const highestLocal = getHighestLocalMatch(matches);

      if (!mostRecentLocal || !highestLocal) {
        return item;
      }

      // CHANGE: Use getValidTime for safe timestamp extraction
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

      // CHANGE: Return safeItemTs (Trakt's paused_at timestamp) instead of
      // mergedLastUpdated (which took the MAX of local and Trakt timestamps).
      // The old approach let local storage timestamps corrupt sort order on the
      // 4-second trailing refresh — a show watched locally months ago would get
      // a recent local timestamp and jump to the top of the list.
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
    })
    .filter((item) => (item.progress ?? 0) < 85);

  // CHANGE: Replaced compareContinueWatchingItems (from utils) with an inline
  // sort using getValidTime so NaN timestamps can't affect order, and all items
  // (both playback and up next) sort together by recency.
  const finalItems = adjustedItems
    .sort((a, b) => getValidTime(b.lastUpdated) - getValidTime(a.lastUpdated))
    .slice(0, 30);

  setContinueWatchingItems(finalItems);

  if (reconcileLocalPromises.length > 0) {
    Promise.allSettled(reconcileLocalPromises).catch(() => null);
  }
}