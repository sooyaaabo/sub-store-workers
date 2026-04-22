import { version as substoreVersion } from '../../package.json';
import { ENV } from '@/vendor/open-api';

const {
    isNode,
    isQX,
    isLoon,
    isSurge,
    isStash,
    isShadowRocket,
    isLanceX,
    isEgern,
    isGUIforCores,
    isWorker,
} = ENV();

let backend = 'Workers';

let meta = {
    worker: {
        runtime: 'Cloudflare Workers',
    },
};
let feature = {};

export default {
    backend,
    version: substoreVersion,
    feature,
    meta,
    isNode,
    isQX,
    isLoon,
    isSurge,
    isStash,
    isShadowRocket,
    isLanceX,
    isEgern,
    isGUIforCores,
    isWorker,
};
