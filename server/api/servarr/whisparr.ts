import type { DVRSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { RadarrMovie } from './radarr';
import RadarrAPI from './radarr';

/**
 * Whisparr V3 ("Eros") is a Radarr fork and serves the same `/api/v3` surface:
 * movie, qualityprofile, rootfolder, tag, queue and command are identical.
 *
 * The one incompatibility is the TMDB lookup. Radarr resolves
 * `movie/lookup?term=tmdb:<id>` through its search proxy, and Whisparr's proxy
 * only understands that prefix while its metadata source is set to TMDB (it can
 * also be pointed at TPDB, or disabled). `movie/lookup/tmdb` asks the metadata
 * provider directly and works regardless of that setting, so we use it here.
 *
 * Whisparr V2 is a Sonarr fork keyed on TPDB studio ids, which have no mapping
 * to anything Seerr knows about, so only V3 is supported.
 */
class WhisparrAPI extends RadarrAPI {
  public override async getMovieByTmdbId(id: number): Promise<RadarrMovie> {
    try {
      const response = await this.axios.get<RadarrMovie>('/movie/lookup/tmdb', {
        params: { tmdbId: id },
      });

      if (!response.data) {
        throw new Error('Movie not found');
      }

      return response.data;
    } catch (e) {
      logger.error('Error retrieving movie by TMDB ID', {
        label: 'Whisparr API',
        errorMessage: e.message,
        tmdbId: id,
      });
      throw e;
    }
  }
}

/**
 * Whisparr servers are stored in `settings.radarr` with `isWhisparr` set, so
 * availability sync, the download tracker, the scanners and the queue keep
 * working against them unchanged. Only the code paths that resolve a movie by
 * TMDB id (add and remove) need the subclass, and those must go through here.
 */
export const createMovieClient = (
  server: DVRSettings & { isWhisparr?: boolean }
): RadarrAPI => {
  const ApiClass = server.isWhisparr ? WhisparrAPI : RadarrAPI;

  return new ApiClass({
    apiKey: server.apiKey,
    url: ApiClass.buildUrl(server, '/api/v3'),
  });
};

export default WhisparrAPI;
