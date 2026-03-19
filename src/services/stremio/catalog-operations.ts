import axios from 'axios';

import { logger } from '../../utils/logger';
import { createSafeAxiosConfig, safeAxiosConfig } from '../../utils/axiosConfig';

import type { StremioServiceContext } from './context';
import type {
  AddonCapabilities,
  AddonCatalogItem,
  CatalogFilter,
  Manifest,
  Meta,
  MetaDetails,
  ResourceObject,
} from './types';

export async function isValidContentId(
  ctx: StremioServiceContext,
  type: string,
  id: string | null | undefined,
  getAllSupportedTypes: () => string[],
  getAllSupportedIdPrefixes: (type: string) => string[]
): Promise<boolean> {
  await ctx.ensureInitialized();

  const supportedTypes = getAllSupportedTypes();
  const isValidType = supportedTypes.includes(type);
  const lowerId = (id || '').toLowerCase();
  const isNullishId = !id || lowerId === 'null' || lowerId === 'undefined';
  const providerLikeIds = new Set<string>(['moviebox', 'torbox']);
  const isProviderSlug = providerLikeIds.has(lowerId);

  if (!isValidType || isNullishId || isProviderSlug) {
    return false;
  }

  const supportedPrefixes = getAllSupportedIdPrefixes(type);
  if (supportedPrefixes.length === 0) {
    return true;
  }

  return supportedPrefixes.some(prefix => {
    const lowerPrefix = prefix.toLowerCase();
    if (!lowerId.startsWith(lowerPrefix)) {
      return false;
    }

    if (lowerPrefix.endsWith(':') || lowerPrefix.endsWith('_')) {
      return true;
    }

    return lowerId.length > lowerPrefix.length;
  });
}

export async function getAllCatalogs(
  ctx: StremioServiceContext
): Promise<Record<string, Meta[]>> {
  const result: Record<string, Meta[]> = {};
  const promises = ctx.getInstalledAddons().map(async addon => {
    const catalog = addon.catalogs?.[0];
    if (!catalog) {
      return;
    }

    try {
      const items = await getCatalog(ctx, addon, catalog.type, catalog.id);
      if (items.length > 0) {
        result[addon.id] = items;
      }
    } catch (error) {
      logger.error(`Failed to fetch catalog from ${addon.name}:`, error);
    }
  });

  await Promise.all(promises);
  return result;
}

export async function getCatalog(
  ctx: StremioServiceContext,
  manifest: Manifest,
  type: string,
  id: string,
  page = 1,
  filters: CatalogFilter[] = []
): Promise<Meta[]> {
  const encodedId = encodeURIComponent(id);
  const pageSkip = (page - 1) * ctx.DEFAULT_PAGE_SIZE;

  if (!manifest.url) {
    throw new Error('Addon URL is missing');
  }

  try {
    const { baseUrl, queryParams } = ctx.getAddonBaseURL(manifest.url);
    const extraParts: string[] = [];

    if (filters.length > 0) {
      filters
        .filter(filter => filter && filter.value)
        .forEach(filter => {
          extraParts.push(
            `${encodeURIComponent(filter.title)}=${encodeURIComponent(filter.value)}`
          );
        });
    }

    if (pageSkip > 0) {
      extraParts.push(`skip=${pageSkip}`);
    }

    const extraArgsPath = extraParts.length > 0 ? `/${extraParts.join('&')}` : '';
    const urlPathStyle =
      `${baseUrl}/catalog/${type}/${encodedId}${extraArgsPath}.json` +
      `${queryParams ? `?${queryParams}` : ''}`;
    const urlSimple = `${baseUrl}/catalog/${type}/${encodedId}.json${queryParams ? `?${queryParams}` : ''}`;

    const legacyFilterQuery = filters
      .filter(filter => filter && filter.value)
      .map(filter => `&${encodeURIComponent(filter.title)}=${encodeURIComponent(filter.value)}`)
      .join('');

    let urlQueryStyle =
      `${baseUrl}/catalog/${type}/${encodedId}.json` +
      `?skip=${pageSkip}&limit=${ctx.DEFAULT_PAGE_SIZE}`;
    if (queryParams) {
      urlQueryStyle += `&${queryParams}`;
    }
    urlQueryStyle += legacyFilterQuery;

    let response;

    try {
      if (pageSkip === 0 && extraParts.length === 0) {
        response = await ctx.retryRequest(() => axios.get(urlSimple, safeAxiosConfig));
        if (!response?.data?.metas?.length) {
          throw new Error('Empty response from simple URL');
        }
      } else {
        throw new Error('Has extra args, use path-style');
      }
    } catch {
      try {
        response = await ctx.retryRequest(() => axios.get(urlPathStyle, safeAxiosConfig));
        if (!response?.data?.metas?.length) {
          throw new Error('Empty response from path-style URL');
        }
      } catch {
        response = await ctx.retryRequest(() => axios.get(urlQueryStyle, safeAxiosConfig));
      }
    }

    if (!response?.data) {
      return [];
    }

    const hasMore = typeof response.data.hasMore === 'boolean' ? response.data.hasMore : undefined;
    const key = `${manifest.id}|${type}|${id}`;
    if (typeof hasMore === 'boolean') {
      ctx.catalogHasMore.set(key, hasMore);
    }

    return Array.isArray(response.data.metas) ? response.data.metas : [];
  } catch (error) {
    logger.error(`Failed to fetch catalog from ${manifest.name}:`, error);
    throw error;
  }
}

export function getCatalogHasMore(
  ctx: StremioServiceContext,
  manifestId: string,
  type: string,
  id: string
): boolean | undefined {
  return ctx.catalogHasMore.get(`${manifestId}|${type}|${id}`);
}

/**
 * Check if an addon can serve metadata for this ID by matching ID prefix.
 * Does NOT require a type match — type is resolved separately via resolveTypeForAddon.
 */
function addonCanServeId(addon: Manifest, id: string): boolean {
  for (const resource of addon.resources || []) {
    if (typeof resource === 'object' && resource !== null && 'name' in resource) {
      const r = resource as ResourceObject;
      if (r.name !== 'meta') continue;
      if (!r.idPrefixes?.length) return true;
      if (r.idPrefixes.some(p => id.startsWith(p))) return true;
    } else if (resource === 'meta') {
      if (!addon.idPrefixes?.length) return true;
      if (addon.idPrefixes.some(p => id.startsWith(p))) return true;
    }
  }
  return false;
}

/**
 * Resolve the correct type to use in the metadata URL for a given addon.
 * Looks at what types the addon declares for its meta resource matching this ID prefix,
 * rather than blindly trusting the passed-in type (which may be "other", "Movie", etc.).
 * Falls back to lowercased passed-in type if no better match found.
 */
function resolveTypeForAddon(addon: Manifest, type: string, id: string): string {
  const lowerFallback = type ? type.toLowerCase() : type;
  for (const resource of addon.resources || []) {
    if (typeof resource === 'object' && resource !== null && 'name' in resource) {
      const r = resource as ResourceObject;
      if (r.name !== 'meta' || !r.types?.length) continue;
      const prefixMatch = !r.idPrefixes?.length || r.idPrefixes.some(p => id.startsWith(p));
      if (prefixMatch) {
        const exact = r.types.find(t => t.toLowerCase() === lowerFallback);
        return exact ?? r.types[0];
      }
    }
  }
  if (addon.types?.length) {
    const exact = addon.types.find(t => t.toLowerCase() === lowerFallback);
    return exact ?? addon.types[0];
  }
  return lowerFallback;
}

async function fetchMetaFromAddon(
  ctx: StremioServiceContext,
  addon: Manifest,
  type: string,
  id: string
): Promise<MetaDetails | null> {
  const resolvedType = resolveTypeForAddon(addon, type, id);
  const { baseUrl, queryParams } = ctx.getAddonBaseURL(addon.url || '');
  const encodedId = encodeURIComponent(id);
  const url = queryParams
    ? `${baseUrl}/meta/${resolvedType}/${encodedId}.json?${queryParams}`
    : `${baseUrl}/meta/${resolvedType}/${encodedId}.json`;

  const response = await ctx.retryRequest(() => axios.get(url, createSafeAxiosConfig(10000)));
  return response.data?.meta?.id ? response.data.meta : null;
}

export async function getMetaDetails(
  ctx: StremioServiceContext,
  type: string,
  id: string,
  preferredAddonId?: string
): Promise<MetaDetails | null> {
  try {
    // isValidContentId gate removed — addonCanServeId() handles per-addon ID prefix
    // filtering correctly. The gate caused false negatives when type was non-standard
    // or prefixes weren't indexed yet, silently returning null before any addon was tried.
    const lowerId = (id || '').toLowerCase();
    if (!id || lowerId === 'null' || lowerId === 'undefined' || lowerId === 'moviebox' || lowerId === 'torbox') {
      return null;
    }

    const addons = ctx.getInstalledAddons();

    if (preferredAddonId) {
      const preferredAddon = addons.find(addon => addon.id === preferredAddonId);
      if (preferredAddon?.resources && addonCanServeId(preferredAddon, id)) {
        try {
          const meta = await fetchMetaFromAddon(ctx, preferredAddon, type, id);
          if (meta) {
            return meta;
          }
        } catch {
          // Fall through to other addons.
        }
      }
    }

    for (const baseUrl of ['https://v3-cinemeta.strem.io', 'http://v3-cinemeta.strem.io']) {
      try {
        const encodedId = encodeURIComponent(id);
        const url = `${baseUrl}/meta/${type ? type.toLowerCase() : type}/${encodedId}.json`;
        const response = await ctx.retryRequest(() => axios.get(url, createSafeAxiosConfig(10000)));
        if (response.data?.meta?.id) {
          return response.data.meta;
        }
      } catch {
        // Try next Cinemeta URL.
      }
    }

    for (const addon of addons) {
      if (!addon.resources || addon.id === 'com.linvo.cinemeta' || addon.id === preferredAddonId) {
        continue;
      }

      if (!addonCanServeId(addon, id)) {
        continue;
      }

      try {
        const meta = await fetchMetaFromAddon(ctx, addon, type, id);
        if (meta) {
          return meta;
        }
      } catch {
        // Try next addon.
      }
    }

    return null;
  } catch (error) {
    logger.error('Error in getMetaDetails:', error);
    return null;
  }
}

export async function getUpcomingEpisodes(
  ctx: StremioServiceContext,
  type: string,
  id: string,
  options: {
    daysBack?: number;
    daysAhead?: number;
    maxEpisodes?: number;
    preferredAddonId?: string;
  } = {}
): Promise<{ seriesName: string; poster: string; episodes: any[] } | null> {
  const { daysBack = 14, daysAhead = 28, maxEpisodes = 50, preferredAddonId } = options;

  try {
    const metadata = await ctx.getMetaDetails(type, id, preferredAddonId);
    if (!metadata) {
      return null;
    }

    if (!metadata.videos?.length) {
      return {
        seriesName: metadata.name,
        poster: metadata.poster || '',
        episodes: [],
      };
    }

    const now = new Date();
    const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const endDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const episodes = metadata.videos
      .filter(video => {
        if (!video.released) {
          logger.log(`[StremioService] Episode ${video.id} has no release date`);
          return false;
        }

        const releaseDate = new Date(video.released);
        return releaseDate >= startDate && releaseDate <= endDate;
      })
      .sort((left, right) => new Date(left.released).getTime() - new Date(right.released).getTime())
      .slice(0, maxEpisodes);

    return {
      seriesName: metadata.name,
      poster: metadata.poster || '',
      episodes,
    };
  } catch (error) {
    logger.error(`[StremioService] Error fetching upcoming episodes for ${id}:`, error);
    return null;
  }
}

export function getAddonCapabilities(ctx: StremioServiceContext): AddonCapabilities[] {
  return ctx.getInstalledAddons().map(addon => ({
    name: addon.name,
    id: addon.id,
    version: addon.version,
    catalogs: addon.catalogs || [],
    resources: (addon.resources || []).filter(
      (resource): resource is ResourceObject => typeof resource === 'object' && resource !== null
    ),
    types: addon.types || [],
  }));
}

export async function getCatalogPreview(
  ctx: StremioServiceContext,
  addonId: string,
  type: string,
  id: string,
  limit = 5
): Promise<{
  addon: string;
  type: string;
  id: string;
  items: Meta[];
}> {
  const addon = ctx.getInstalledAddons().find(entry => entry.id === addonId);
  if (!addon) {
    throw new Error(`Addon ${addonId} not found`);
  }

  const items = await ctx.getCatalog(addon, type, id);
  return {
    addon: addonId,
    type,
    id,
    items: items.slice(0, limit),
  };
}

export async function getAddonCatalogs(
  ctx: StremioServiceContext,
  type: string,
  id: string
): Promise<AddonCatalogItem[]> {
  await ctx.ensureInitialized();

  const addons = ctx.getInstalledAddons().filter(addon =>
    addon.resources?.some(resource =>
      typeof resource === 'string'
        ? resource === 'addon_catalog'
        : (resource as ResourceObject).name === 'addon_catalog'
    )
  );

  if (addons.length === 0) {
    logger.log('[getAddonCatalogs] No addons provide addon_catalog resource');
    return [];
  }

  const results: AddonCatalogItem[] = [];

  for (const addon of addons) {
    try {
      const { baseUrl, queryParams } = ctx.getAddonBaseURL(addon.url || '');
      const url =
        `${baseUrl}/addon_catalog/${type}/${encodeURIComponent(id)}.json` +
        `${queryParams ? `?${queryParams}` : ''}`;

      logger.log(`[getAddonCatalogs] Fetching from ${addon.name}: ${url}`);
      const response = await ctx.retryRequest(() => axios.get(url, createSafeAxiosConfig(10000)));

      if (Array.isArray(response.data?.addons)) {
        results.push(...response.data.addons);
      }
    } catch (error) {
      logger.warn(`[getAddonCatalogs] Failed to fetch from ${addon.name}:`, error);
    }
  }

  return results;
}
