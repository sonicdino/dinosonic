import { Context, Hono } from '@hono/hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { InternetRadioStation } from '../../zod.ts';

const getInternetRadioStations = new Hono();

async function handleGetInternetRadioStations(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const internetRadioStation = (await Array.fromAsync(database.list({ prefix: ['radioStations'] }))).map((
        stations,
    ) => (stations.value as InternetRadioStation));

    return createResponse(c, { internetRadioStations: { internetRadioStation } }, 'ok');
}

getInternetRadioStations.get('/getInternetRadioStations', handleGetInternetRadioStations);
getInternetRadioStations.post('/getInternetRadioStations', handleGetInternetRadioStations);
getInternetRadioStations.get('/getInternetRadioStations.view', handleGetInternetRadioStations);
getInternetRadioStations.post('/getInternetRadioStations.view', handleGetInternetRadioStations);

export default getInternetRadioStations;
