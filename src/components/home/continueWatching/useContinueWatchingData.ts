import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { SimklService } from '../../../services/simklService';
import { storageService } from '../../../services/storageService';
import { TraktService } from '../../../services/traktService';
import { watchedService } from '../../../services/watchedService';

import { REMOVAL_IGNORE_DURATION } from './constants';
import {
  createGetCachedMetadata,
  dedupeLocalItems,
  filterRemovedItems,
} from './dataShared';
import { CachedMetadataEntry, LocalProgressEntry } from './dataTypes';
import { loadLocalContinueWatching } from './loadLocalContinueWatching';
import { mergeSimklContinueWatching } from './mergeSimklContinueWatching';
import { mergeTraktContinueWatching } from './mergeTraktContinueWatching';
import { ContinueWatchingItem } from './types';
import { getContinueWatchingItemKey, getContinueWatchingRemoveId, getIdVariants, parseEpisodeId } from './utils';

async function getTraktMoviesSet(
  isTraktAuthed: boolean,
  traktService: TraktService
): Promise<Set<string>> {
  try {
    if (!isTraktAuthed || typeof (traktService as any).getWatchedMovies !== 'function') {
      return new Set<string>();
    }

    const watched = await (traktService as any).getWatchedMovies();
    const watchedSet = new Set<string>();

    if (Array.isArray(watched)) {
      watched.forEach((movie: any) => {
        const ids = movie?.movie?.ids;
        if (!ids) return;

        if (ids.imdb) {
          watchedSet.add(ids.imdb.startsWith('tt') ? ids.imdb : `tt${ids.imdb}`);
        }
        if (ids.tmdb) {
          watchedSet.add(ids.tmdb.toString());
        }
      });
    }

    return watchedSet;
  } catch {
    return new Set<string>();
  }
}

async function getTraktShowsSet(
  isTraktAuthed: boolean,
  traktService: TraktService
): Promise<Set<string>> {
  try {
    if (!isTraktAuthed || typeof (traktService as any).getWatchedShows !== 'function') {
      return new Set<string>();
    }

    const watched = await (traktService as any).getWatchedShows();
    const watchedSet = new Set<string>();

    if (Array.isArray(watched)) {
      watched.forEach((show: any) => {
        const ids = show?.show?.ids;
        if (!ids) return;

        const imdbId = ids.imdb;
        const tmdbId = ids.tmdb;

        if (!Array.isArray(show.seasons)) return;

        show.seasons.forEach((season: any) => {
          if (!Array.isArray(season.episodes)) return;

          season.episodes.forEach((episode: any) => {
            if (imdbId) {
              const cleanImdbId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
              watchedSet.add(`${cleanImdbId}:${season.number}:${episode.number}`);
            }
            if (tmdbId) {
              watchedSet.add(`${tmdbId}:${season.number}:${episode.number}`);
            }
          });
        });
      });
    }

    return watchedSet;
  } catch {
    return new Set<string>();
  }
}

async function getLocalWatchedShowsMap(): Promise<Map<string, number>> {
  try {
    const watched = await watchedService.getAllWatchedItems();
    const watchedMap = new Map<string, number>();

    watched.forEach((item) => {
      if (!item.content_id) return;

      const cleanId = item.content_id.startsWith('tt')
        ? item.content_id
        : `tt${item.content_id}`;

      if (item.season != null && item.episode != null) {
        watchedMap.set(`${cleanId}:${item.season}:${item.episode}`, item.watched_at);
        watchedMap.set(`${item.content_id}:${item.season}:${item.episode}`, item.watched_at);
      } else {
        watchedMap.set(cleanId, item.watched_at);
        watchedMap.set(item.content_id, item.watched_at);
      }
    });

    return watchedMap;
  } catch {
    return new Map<string, number>();
  }
}

async function buildLocalProgressIndex(
  shouldBuild: boolean
): Promise<Map<string, LocalProgressEntry[]> | null> {
  if (!shouldBuild) {
    return null;
  }

  try {
    const allProgress = await storageService.getAllWatchProgress();
    const index = new Map<string, LocalProgressEntry[]>();

    for (const [key, progress] of Object.entries(allProgress)) {
      const [type, id, ...episodeIdParts] = key.split(':');
      const episodeId = episodeIdParts.length > 0 ? episodeIdParts.join(':') : undefined;

      const progressPercent =
        progress?.duration > 0 ? (progress.currentTime / progress.duration) * 100 : 0;

      if (!isFinite(progressPercent) || progressPercent <= 0) continue;

      const parsed = parseEpisodeId(episodeId);
      const entry: LocalProgressEntry = {
        episodeId,
        season: parsed?.season,
        episode: parsed?.episode,
        progressPercent,
        lastUpdated: progress?.lastUpdated ?? 0,
        currentTime: progress?.currentTime ?? 0,
        duration: progress?.duration ?? 0,
      };

      for (const idVariant of getIdVariants(id)) {
        const idxKey = `${type}:${idVariant}`;
        const list = index.get(idxKey);
        if (list) {
          list.push(entry);
        } else {
          index.set(idxKey, [entry]);
        }
      }
    }

    return index;
  } catch {
    return null;
  }
}

export function useContinueWatchingData() {
  const [continueWatchingItems, setContinueWatchingItems] = useState<ContinueWatchingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  const appState = useRef(AppState.currentState);
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingRefreshRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const recentlyRemovedRef = useRef<Set<string>>(new Set());
  const lastTraktSyncRef = useRef<number>(0);
  const lastSimklSyncRef = useRef<number>(0);
  const lastTraktReconcileRef = useRef<Map<string, number>>(new Map());
  const metadataCache = useRef<Record<string, CachedMetadataEntry>>({});

  const getCachedMetadata = useMemo(
    () => createGetCachedMetadata(metadataCache),
    []
  );

  const loadContinueWatching = useCallback(async (isBackgroundRefresh = false) => {
    if (isRefreshingRef.current) {
      pendingRefreshRef.current = true;
      return;
    }

    if (!isBackgroundRefresh) {
      setLoading(true);
    }
    isRefreshingRef.current = true;

    try {
      const traktService = TraktService.getInstance();
      const isTraktAuthed = await traktService.isAuthenticated();

      const simklService = SimklService.getInstance();
      const isSimklAuthed = !isTraktAuthed ? await simklService.isAuthenticated() : false;

      console.log(`[CW-Hook] Auth state: trakt=${isTraktAuthed} simkl=${isSimklAuthed}`);

      const traktMoviesSetPromise = getTraktMoviesSet(isTraktAuthed, traktService);
      const traktShowsSetPromise = getTraktShowsSet(isTraktAuthed, traktService);
      const localWatchedShowsMapPromise = getLocalWatchedShowsMap();
      const localProgressIndex = await buildLocalProgressIndex(
        isTraktAuthed || isSimklAuthed
      );

      if (!isTraktAuthed && !isSimklAuthed) {
        const { items, shouldClearItems } = await loadLocalContinueWatching({
          getCachedMetadata,
          traktMoviesSetPromise,
          traktShowsSetPromise,
          localWatchedShowsMapPromise,
        });

        if (shouldClearItems) {
          setContinueWatchingItems([]);
          return;
        }

        const filtered = await filterRemovedItems(
          dedupeLocalItems(items),
          recentlyRemovedRef.current
        );
        setContinueWatchingItems(filtered);
        return;
      }

      await Promise.allSettled([
        isTraktAuthed
          ? (console.log('[CW-Hook] Calling mergeTraktContinueWatching...'), mergeTraktContinueWatching({
              traktService,
              getCachedMetadata,
              localProgressIndex,
              localWatchedShowsMapPromise,
              recentlyRemoved: recentlyRemovedRef.current,
              lastTraktSyncRef,
              lastTraktReconcileRef,
              setContinueWatchingItems,
            }))
          : (console.log('[CW-Hook] Trakt NOT authed, skipping merge'), Promise.resolve()),
        isSimklAuthed && !isTraktAuthed
          ? mergeSimklContinueWatching({
              simklService,
              getCachedMetadata,
              localProgressIndex,
              traktShowsSetPromise,
              localWatchedShowsMapPromise,
              recentlyRemoved: recentlyRemovedRef.current,
              lastSimklSyncRef,
              setContinueWatchingItems,
            })
          : Promise.resolve(),
      ]);
    } catch {
      // Keep UI usable even if sync fails.
    } finally {
      setLoading(false);
      isRefreshingRef.current = false;

      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        setTimeout(() => {
          loadContinueWatching(true);
        }, 0);
      }
    }
  }, [getCachedMetadata]);

  useEffect(() => {
    return () => {
      metadataCache.current = {};
    };
  }, []);

  const handleAppStateChange = useCallback((nextAppState: AppStateStatus) => {
    if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
      lastTraktSyncRef.current = 0;
      loadContinueWatching(true);
    }

    appState.current = nextAppState;
  }, [loadContinueWatching]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', handleAppStateChange);

    const watchProgressUpdateHandler = () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }

      refreshTimerRef.current = setTimeout(() => {
        loadContinueWatching(true);
      }, 2000);
    };

    if (storageService.subscribeToWatchProgressUpdates) {
      const unsubscribe =
        storageService.subscribeToWatchProgressUpdates(watchProgressUpdateHandler);

      return () => {
        subscription.remove();
        unsubscribe();
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
        }
      };
    }

    const intervalId = setInterval(() => loadContinueWatching(true), 300000);
    return () => {
      subscription.remove();
      clearInterval(intervalId);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [handleAppStateChange, loadContinueWatching]);

  useEffect(() => {
    loadContinueWatching();
    const trailingRefreshId = setTimeout(() => {
      loadContinueWatching(true);
    }, 4000);

    return () => {
      clearTimeout(trailingRefreshId);
    };
  }, [loadContinueWatching]);

  useFocusEffect(
    useCallback(() => {
      loadContinueWatching(true);
      return () => {};
    }, [loadContinueWatching])
  );

  const refresh = useCallback(async () => {
    lastTraktSyncRef.current = 0;
    await loadContinueWatching(false);
    return true;
  }, [loadContinueWatching]);

  const removeItem = useCallback(async (item: ContinueWatchingItem) => {
    setDeletingItemId(item.id);

    try {
      const isEpisode = item.type === 'series' && item.season && item.episode;
      if (isEpisode) {
        await storageService.removeWatchProgress(
          item.id,
          item.type,
          `${item.id}:${item.season}:${item.episode}`
        );
      } else {
        await storageService.removeAllWatchProgressForContent(item.id, item.type, {
          addBaseTombstone: true,
        });
      }

      const traktService = TraktService.getInstance();
      const isAuthed = await traktService.isAuthenticated();
      if (isAuthed && item.traktPlaybackId) {
        await traktService.removePlaybackItem(item.traktPlaybackId);
      }

      const itemKey = getContinueWatchingItemKey(item);
      recentlyRemovedRef.current.add(itemKey);
      await storageService.addContinueWatchingRemoved(
        getContinueWatchingRemoveId(item),
        item.type
      );

      setTimeout(() => {
        recentlyRemovedRef.current.delete(itemKey);
      }, REMOVAL_IGNORE_DURATION);

      setContinueWatchingItems((prev) =>
        prev.filter((currentItem) => getContinueWatchingItemKey(currentItem) !== itemKey)
      );
    } catch {
      // Keep UI state stable even if provider removal fails.
    } finally {
      setDeletingItemId(null);
    }
  }, []);

  return {
    continueWatchingItems,
    loading,
    deletingItemId,
    refresh,
    removeItem,
  };
}
