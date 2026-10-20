// Reads search data from the app services that are already running in the background.
// Each app is read on its own: one broken or unavailable app leaves the others searchable.
import { getSharedCharactersService } from '../characters/service.js';
import { getSharedInventoryService } from '../inventory/service.js';
import { getSharedService as getJournal } from '../journal/service.js';
import { inspectEntries } from '../journal/model.js';
import { getSharedService as getInformation } from '../information/service.js';
import { current as currentRecords } from '../information/model.js';
import { getSharedService as getEffects } from '../effects/service.js';
import { activeEffects } from '../effects/model.js';
import { getStore as getOrganizations } from '../organizations/service.js';
import { legacyModule } from '../story-state/access.js';

const MAP_KEY = 'dynamicMapV1';
export async function readSearchData(getContext = () => globalThis.SillyTavern?.getContext?.()) {
    const ctx = getContext(), data = {}, errors = [];
    const read = async (key, label, fn) => { try { data[key] = await fn(); } catch (error) { errors.push(`${label}：${error?.message ?? error}`); } };
    await read('characters', '人物卡', () => getSharedCharactersService().read().characters);
    await read('inventory', '背包与账本', () => getSharedInventoryService().read());
    await read('journal', '剧情档案', () => inspectEntries(getJournal().read(), ctx?.chat ?? []).filter(entry => entry.current));
    await read('map', '地图', () => ({ maps: legacyModule(ctx, 'map', MAP_KEY)?.document?.maps ?? {} }));
    await read('organizations', '势力概览', async () => (await getOrganizations()).read());
    await read('information', '信息面板', () => currentRecords(getInformation().read(), ctx?.chat ?? []));
    await read('effects', '能力面板', () => { const store = getEffects().read(); return { skills: store.skills, active: activeEffects(store, ctx?.chat ?? []) }; });
    return { data, errors };
}
