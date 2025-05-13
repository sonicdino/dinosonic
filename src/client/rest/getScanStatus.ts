import { Context, Hono } from '@hono/hono';
import { createResponse, validateAuth } from '../../util.ts';
import { GetScanStatus } from '../../MediaScanner.ts';

const getScanStatus = new Hono();

async function handlegetScanStatus(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    return createResponse(c, { scanStatus: GetScanStatus() }, 'ok');
}

getScanStatus.get('/getScanStatus', handlegetScanStatus);
getScanStatus.post('/getScanStatus', handlegetScanStatus);
getScanStatus.get('/getScanStatus.view', handlegetScanStatus);
getScanStatus.post('/getScanStatus.view', handlegetScanStatus);

export default getScanStatus;
