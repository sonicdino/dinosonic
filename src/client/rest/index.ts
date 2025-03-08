import { Hono } from 'hono';
const restRoutes = new Hono();

// Opensubsonic (subsonic) api endpoints.
import ping from './ping.ts';
import getLicense from './getLicense.ts';
import getOpenSubsonicExtensions from './getOpenSubsonicExtensions.ts';
import download from './download.ts';
import getLyrics from './getLyrics.ts';
import search from './search.ts';
import getSong from './getSong.ts';
import getAlbum from './getAlbum.ts';
import getArtist from './getArtist.ts';
import getArtists from './getArtists.ts';
import getCoverArt from './getCoverArt.ts';

restRoutes.route('/', ping);
restRoutes.route('/', getLicense);
restRoutes.route('/', getOpenSubsonicExtensions);
restRoutes.route('/', download);
restRoutes.route('/', getLyrics);
restRoutes.route('/', search);
restRoutes.route('/', getSong);
restRoutes.route('/', getAlbum);
restRoutes.route('/', getArtist);
restRoutes.route('/', getArtists);
restRoutes.route('/', getCoverArt);

export default restRoutes;
