import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';

const deleteInternetRadioStation = new Hono();

async function handleDeleteInternetRadioStation(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id');
    if (!id) return createResponse(c, { error: 'Missing id parameter' }, 'failed');

    await database.delete(['radioStations', id]);

    return createResponse(c, {}, 'ok');
}

deleteInternetRadioStation.get('/deleteInternetRadioStation', handleDeleteInternetRadioStation);
deleteInternetRadioStation.post('/deleteInternetRadioStation', handleDeleteInternetRadioStation);
deleteInternetRadioStation.get('/deleteInternetRadioStation.view', handleDeleteInternetRadioStation);
deleteInternetRadioStation.post('/deleteInternetRadioStation.view', handleDeleteInternetRadioStation);

export default deleteInternetRadioStation;
