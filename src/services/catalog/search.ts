import axios from 'axios';

import { stremioService, type Manifest } from '../stremioService';
import { logger } from '../../utils/logger';
import { createSafeAxiosConfig } from '../../utils/axiosConfig';

import { canSearchCatalog, getAllAddons } from './catalog-utils';
import { convertMetaToStreamingContent } from './content-mappers';
import type { AddonSearchResults, GroupedSearchResults, StreamingContent } from './types';

type PendingSection = {
  addonId: string;
  addonName: string;
  sectionName: string;
  catalogIndex: number;
  results: StreamingContent[];
};

export async function searchContent(
  library: Record<string, StreamingContent>,
  query: string
): Promise<StreamingContent[]> {
  if (!query || query.trim().length < 2) {
    return [];
  }

  const addons = await getAllAddons(() => stremioService.getInstalledAddonsAsync());
  const manifests = await stremioService.getInstalledAddonsAsync();
  const manifestMap = new Map(manifests.map(manifest => [manifest.id, manifest]));
  const results: StreamingContent[] = [];

  await Promise.all(
    addons.flatMap(addon =>
      (addon.catalogs || [])
        .filter(catalog => canSearchCatalog(catalog))
        .map(async catalog => {
          const manifest = manifestMap.get(addon.id);
          if (!manifest) {
            return;
          }

          try {
            const metas = await stremioService.getCatalog(
              manifest,
              catalog.type,
              catalog.id,
              1,
              [{ title: 'search', value: query }]
            );

            if (metas?.length) {
              results.push(
                ...metas.map(meta => ({
                  ...convertMetaToStreamingContent(meta, library),
                  addonId: addon.id,
                }))
              );
            }
          } catch (error) {
            logger.error(`Search failed for ${catalog.id} in addon ${addon.id}:`, error);
          }
        })
    )
  );

  return Array.from(new Map(results.map(item => [`${item.type}:${item.id}`, item])).values());
}

export async function searchContentCinemeta(
  library: Record<string, StreamingContent>,
  query: string
): Promise<GroupedSearchResults> {
  if (!query) {
    return { byAddon: [], allResults: [] };
  }

  const trimmedQuery = query.trim().toLowerCase();
  logger.log('Searching across all addons for:', trimmedQuery);

  const addons = await getAllAddons(() => stremioService.getInstalledAddonsAsync());
  const manifests = await stremioService.getInstalledAddonsAsync();
  const manifestMap = new Map(manifests.map(manifest => [manifest.id, manifest]));
  const searchableAddons = addons.filter(addon => addon.catalogs.some(catalog => canSearchCatalog(catalog)));
  const byAddon: AddonSearchResults[] = [];

  logger.log(`Found ${searchableAddons.length} searchable addons:`, searchableAddons.map(addon => addon.name).join(', '));

  for (const [addonIndex, addon] of searchableAddons.entries()) {
    const manifest = manifestMap.get(addon.id);
    if (!manifest) {
      logger.warn(`Manifest not found for addon ${addon.name} (${addon.id})`);
      continue;
    }

    const catalogResults = await Promise.allSettled(
      addon.catalogs
        .filter(catalog => canSearchCatalog(catalog))
        .map(catalog => searchAddonCatalog(library, manifest, catalog.type, catalog.id, trimmedQuery))
    );

    const addonResults: StreamingContent[] = [];
    for (const result of catalogResults) {
      if (result.status === 'fulfilled' && result.value) {
        addonResults.push(...result.value);
      } else if (result.status === 'rejected') {
        logger.error(`Search failed for ${addon.name}:`, result.reason);
      }
    }

    if (addonResults.length > 0) {
      const seen = new Set<string>();
      byAddon.push({
        addonId: addon.id,
        addonName: addon.name,
        sectionName: addon.name,
        catalogIndex: addonIndex,
        results: addonResults.filter(item => {
          const key = `${item.type}:${item.id}`;
          if (seen.has(key)) {
            return false;
          }

          seen.add(key);
          return true;
        }),
      });
    }
  }

  const allResults: StreamingContent[] = [];
  const globalSeen = new Set<string>();

  for (const addonGroup of byAddon) {
    for (const item of addonGroup.results) {
      const key = `${item.type}:${item.id}`;
      if (!globalSeen.has(key)) {
        globalSeen.add(key);
        allResults.push(item);
      }
    }
  }

  logger.log(`Search complete: ${byAddon.length} addons returned results, ${allResults.length} unique items total`);
  return { byAddon, allResults };
}

export function startLiveSearch(
  library: Record<string, StreamingContent>,
  query: string,
  onAddonResults: (section: AddonSearchResults) => void
): { cancel: () => void; done: Promise<void> } {
  const controller = { cancelled: false };

  const done = (async () => {
    if (!query || !query.trim()) {
      return;
    }

    const trimmedQuery = query.trim().toLowerCase();
    logger.log('Live search across addons for:', trimmedQuery);

    const addons = await getAllAddons(() => stremioService.getInstalledAddonsAsync());
    logger.log(`Total addons available: ${addons.length}`);

    const manifests = await stremioService.getInstalledAddonsAsync();
    const manifestMap = new Map(manifests.map(manifest => [manifest.id, manifest]));
    const searchableAddons = addons.filter(addon =>
      (addon.catalogs || []).some(catalog => canSearchCatalog(catalog))
    );

    logger.log(
      `Found ${searchableAddons.length} searchable addons:`,
      searchableAddons.map(addon => `${addon.name} (${addon.id})`).join(', ')
    );

    if (searchableAddons.length === 0) {
      logger.warn('No searchable addons found. Make sure you have addons installed that support search functionality.');
      return;
    }

    const addonOrderRef: Record<string, number> = {};
    searchableAddons.forEach((addon, index) => {
      addonOrderRef[addon.id] = index;
    });

    const catalogTypeLabels: Record<string, string> = {
      movie: 'Movies',
      series: 'TV Shows',
      'anime.series': 'Anime Series',
      'anime.movie': 'Anime Movies',
      other: 'Other',
      tv: 'TV',
      channel: 'Channels',
    };
    const genericCatalogNames = new Set(['search', 'Search']);
    const allPendingSections: PendingSection[] = [];

    await Promise.all(
      searchableAddons.map(async addon => {
        if (controller.cancelled) {
          return;
        }

        try {
          const manifest = manifestMap.get(addon.id);
          if (!manifest) {
            logger.warn(`Manifest not found for addon ${addon.name} (${addon.id})`);
            return;
          }

          const searchableCatalogs = (addon.catalogs || []).filter(catalog => canSearchCatalog(catalog));
          logger.log(`Searching ${addon.name} (${addon.id}) with ${searchableCatalogs.length} searchable catalogs`);

          const settled = await Promise.allSettled(
            searchableCatalogs.map(catalog =>
              searchAddonCatalog(library, manifest, catalog.type, catalog.id, trimmedQuery)
            )
          );

          if (controller.cancelled) {
            return;
          }

          const addonRank = addonOrderRef[addon.id] ?? Number.MAX_SAFE_INTEGER;
          if (searchableCatalogs.length > 1) {
            searchableCatalogs.forEach((catalog, index) => {
              const result = settled[index];
              if (result.status === 'rejected' || !result.value?.length) {
                if (result.status === 'rejected') {
                  logger.warn(`Search failed for ${catalog.id} in ${addon.name}:`, result.reason);
                }
                return;
              }

              const sectionName = buildSectionName(
                addon.name,
                catalog.name,
                catalog.type,
                genericCatalogNames,
                catalogTypeLabels
              );

              allPendingSections.push({
                addonId: `${addon.id}||${catalog.type}||${catalog.id}`,
                addonName: addon.name,
                sectionName,
                catalogIndex: addonRank * 1000 + index,
                results: dedupeAndStampResults(result.value, catalog.type),
              });
            });
            return;
          }

          const result = settled[0];
          const catalog = searchableCatalogs[0];
          if (!result || result.status === 'rejected' || !result.value?.length) {
            if (result?.status === 'rejected') {
              logger.warn(`Search failed for ${addon.name}:`, result.reason);
            }
            return;
          }

          allPendingSections.push({
            addonId: addon.id,
            addonName: addon.name,
            sectionName: addon.name,
            catalogIndex: addonRank * 1000,
            results: dedupeAndStampResults(result.value, catalog.type),
          });
        } catch (error) {
          logger.error(`Error searching addon ${addon.name} (${addon.id}):`, error);
        }
      })
    );

    if (controller.cancelled) {
      return;
    }

    allPendingSections.sort((left, right) => left.catalogIndex - right.catalogIndex);
    for (const section of allPendingSections) {
      if (controller.cancelled) {
        return;
      }

      if (section.results.length > 0) {
        logger.log(`Emitting ${section.results.length} results from ${section.sectionName}`);
        onAddonResults(section);
      }
    }
  })();

  return {
    cancel: () => {
      controller.cancelled = true;
    },
    done,
  };
}

async function searchAddonCatalog(
  library: Record<string, StreamingContent>,
  manifest: Manifest,
  type: string,
  catalogId: string,
  query: string
): Promise<StreamingContent[]> {
  try {
    const url = buildSearchUrl(manifest, type, catalogId, query);
    if (!url) {
      return [];
    }

    logger.log(`Searching ${manifest.name} (${type}/${catalogId}):`, url);
    const response = await axios.get<{ metas: any[] }>(url, createSafeAxiosConfig(10000));
    const metas = response.data?.metas || [];

    if (metas.length === 0) {
      return [];
    }

    const items = metas.map(meta => {
      const content = convertMetaToStreamingContent(meta, library);
      // Do NOT set addonId from search results — let getMetaDetails resolve the correct
      // meta addon by ID prefix matching. Setting it here causes 404s when two addons
      // are installed and one returns IDs the other can't serve metadata for.

      const normalizedCatalogType = type ? type.toLowerCase() : type;
      if (normalizedCatalogType && content.type !== normalizedCatalogType) {
        content.type = normalizedCatalogType;
      } else if (content.type) {
        content.type = content.type.toLowerCase();
      }
      return content;
    });

    logger.log(`Found ${items.length} results from ${manifest.name}`);
    return items;
  } catch (error: any) {
    const errorMessage = error?.response?.status
      ? `HTTP ${error.response.status}`
      : error?.message || 'Unknown error';
    const errorUrl = error?.config?.url || 'unknown URL';
    logger.error(`Search failed for ${manifest.name} (${type}/${catalogId}) at ${errorUrl}: ${errorMessage}`);
    if (error?.response?.data) {
      logger.error('Response data:', error.response.data);
    }
    return [];
  }
}

function buildSearchUrl(manifest: Manifest, type: string, catalogId: string, query: string): string | null {
  if (manifest.id === 'com.linvo.cinemeta') {
    return `https://v3-cinemeta.strem.io/catalog/${type}/${encodeURIComponent(catalogId)}/search=${encodeURIComponent(query)}.json`;
  }

  const chosenUrl = manifest.url || manifest.originalUrl;
  if (!chosenUrl) {
    logger.warn(`Addon ${manifest.name} (${manifest.id}) has no URL, skipping search`);
    return null;
  }

  const [baseUrlPart, queryParams] = chosenUrl.split('?');
  let cleanBaseUrl = baseUrlPart.replace(/manifest\.json$/, '').replace(/\/$/, '');
  if (!cleanBaseUrl.startsWith('http')) {
    cleanBaseUrl = `https://${cleanBaseUrl}`;
  }

  let url = `${cleanBaseUrl}/catalog/${type}/${encodeURIComponent(catalogId)}/search=${encodeURIComponent(query)}.json`;
  if (queryParams) {
    url += `?${queryParams}`;
  }

  return url;
}

function dedupeAndStampResults(results: StreamingContent[], catalogType: string): StreamingContent[] {
  const bestById = new Map<string, StreamingContent>();

  for (const item of results) {
    const existing = bestById.get(item.id);
    if (!existing || (!existing.type.includes('.') && item.type.includes('.'))) {
      bestById.set(item.id, item);
    }
  }

  return Array.from(bestById.values()).map(item =>
    catalogType && item.type !== catalogType ? { ...item, type: catalogType } : item
  );
}

function buildSectionName(
  addonName: string,
  catalogName: string | undefined,
  catalogType: string,
  genericCatalogNames: Set<string>,
  catalogTypeLabels: Record<string, string>
): string {
  const typeLabel = catalogTypeLabels[catalogType] ||
    catalogType.replace(/[._]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

  const catalogLabel = (!catalogName || genericCatalogNames.has(catalogName) || catalogName === addonName)
    ? typeLabel
    : catalogName;

  return `${addonName} - ${catalogLabel}`;
}
