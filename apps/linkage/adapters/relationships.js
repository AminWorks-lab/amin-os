import { KEY, relationshipContext } from '../../relationships/model.js';
import { KEY as CHARACTERS_KEY } from '../../characters/model.js';
import { UPDATE_SPEC, UPDATE_CONTRACT, applyRelationshipChange } from '../../relationships/updates.js';

export const adapter = {
    id: 'relationships', label: '人物关系', paths: [[KEY], [CHARACTERS_KEY]], spec: UPDATE_SPEC, contract: UPDATE_CONTRACT,
    read: ctx => relationshipContext(ctx),
    apply(ctx, change, options) {
        const { patches, summary } = applyRelationshipChange(ctx, change, options);
        return { patches, summary };
    },
};
