/** Sub-Store Workers 入口 */

import { version } from '../package.json';
import $ from '@/core/app';
import express from '@/vendor/express';
import migrate from '@/utils/migration';

import registerSubscriptionRoutes from '@/restful/subscriptions';
import registerCollectionRoutes from '@/restful/collections';
import registerArtifactRoutes from '@/restful/artifacts';
import registerFileRoutes from '@/restful/file';
import registerTokenRoutes from '@/restful/token';
import registerArchiveRoutes from '@/restful/archives';
import registerModuleRoutes from '@/restful/module';
import registerSyncRoutes from '@/restful/sync';
import registerDownloadRoutes from '@/restful/download';
import registerSettingRoutes from '@/restful/settings';
import registerPreviewRoutes from '@/restful/preview';
import registerSortingRoutes from '@/restful/sort';
import registerMiscRoutes from '@/restful/miscs';
import registerNodeInfoRoutes from '@/restful/node-info';
import registerParserRoutes from '@/restful/parser';

import { produceArtifact } from '@/restful/sync';
import { syncToGist } from '@/restful/artifacts';
import { gistBackupAction } from '@/restful/miscs';
import { SETTINGS_KEY, ARTIFACTS_KEY, SUBS_KEY, COLLECTIONS_KEY } from '@/constants';
import { findByName } from '@/utils/database';

// 初始化应用及路由
const $app = express({ substore: $ });

registerCollectionRoutes($app);
registerSubscriptionRoutes($app);
registerDownloadRoutes($app);
registerPreviewRoutes($app);
registerSortingRoutes($app);
registerSettingRoutes($app);
registerArtifactRoutes($app);
registerFileRoutes($app);
registerTokenRoutes($app);
registerArchiveRoutes($app);
registerModuleRoutes($app);
registerSyncRoutes($app);
registerNodeInfoRoutes($app);
registerMiscRoutes($app);
registerParserRoutes($app);

export default {
    // 定时同步
    async scheduled(event, env, ctx) {
        ctx.waitUntil(cronSyncArtifacts(env));
    },

    async fetch(request, env, ctx) {
        try {
            // 注入环境变量
            globalThis.__workerEnv = env;

            // 从 KV 加载数据
            await $.initFromKV(env.SUB_STORE_DATA);
            $.workerEnv = env;

            // 数据迁移
            migrate();

            console.log(`Sub-Store Workers v${version} handling: ${request.method} ${new URL(request.url).pathname}`);

            // 路由分发
            const response = await $app.handleRequest(request);

            // 回写 KV
            ctx.waitUntil($.persistCache());

            return response;
        } catch (e) {
            console.error(`Unhandled error: ${e.message}\n${e.stack}`);
            // 出错也尝试回写
            ctx.waitUntil($.persistCache());
            return new Response(
                JSON.stringify({
                    status: 'failed',
                    message: `Internal Server Error: ${e.message}`,
                }),
                {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                },
            );
        }
    },
};

/** 定时同步 artifacts 到 Gist */
async function cronSyncArtifacts(env) {
    try {
        globalThis.__workerEnv = env;
        await $.initFromKV(env.SUB_STORE_DATA);
        $.workerEnv = env;

        console.log(`[Cron] Sub-Store Workers v${version} 开始同步...`);

        const settings = $.read(SETTINGS_KEY);
        if (!settings?.githubUser || !settings?.gistToken) {
            console.log('[Cron] 未配置 GitHub Token，跳过同步');
            return;
        }

        const allArtifacts = $.read(ARTIFACTS_KEY);
        if (!allArtifacts || allArtifacts.length === 0) {
            console.log('[Cron] 无 artifacts，跳过同步');
            return;
        }

        const shouldSync = allArtifacts.some((a) => a.sync);
        if (!shouldSync) {
            console.log('[Cron] 无需同步的配置');
            return;
        }

        // 收集需要同步的订阅名
        const allSubs = $.read(SUBS_KEY);
        const allCols = $.read(COLLECTIONS_KEY);
        const subNames = [];
        let enabledCount = 0;

        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source) {
                enabledCount++;
                if (artifact.type === 'subscription') {
                    const sub = findByName(allSubs, artifact.source);
                    if (sub?.url && !subNames.includes(artifact.source)) {
                        subNames.push(artifact.source);
                    }
                } else if (artifact.type === 'collection') {
                    const col = findByName(allCols, artifact.source);
                    if (col?.subscriptions) {
                        for (const sn of col.subscriptions) {
                            const sub = findByName(allSubs, sn);
                            if (sub?.url && !subNames.includes(sn)) {
                                subNames.push(sn);
                            }
                        }
                    }
                }
            }
        }

        if (enabledCount === 0) {
            console.log('[Cron] 无启用同步的配置');
            return;
        }

        // 预生成订阅缓存
        if (subNames.length > 0) {
            await Promise.all(
                subNames.map(async (name) => {
                    try {
                        await produceArtifact({ type: 'subscription', name, awaitCustomCache: true });
                    } catch (e) { /* 忽略 */ }
                }),
            );
        }

        // 生成所有 artifacts
        const files = {};
        const valid = [];
        const invalid = [];

        await Promise.all(
            allArtifacts.map(async (artifact) => {
                try {
                    if (!artifact.sync || !artifact.source) return;
                    console.log(`[Cron] 正在同步：${artifact.name}...`);

                    const output = await produceArtifact({
                        type: artifact.type,
                        name: artifact.source,
                        platform: artifact.platform,
                        produceOpts: {
                            'include-unsupported-proxy': artifact.includeUnsupportedProxy,
                            useMihomoExternal: artifact.platform === 'SurgeMac',
                            prettyYaml: artifact.prettyYaml,
                        },
                    });

                    files[encodeURIComponent(artifact.name)] = { content: output };
                    valid.push(artifact.name);
                } catch (e) {
                    console.error(`[Cron] 生成 ${artifact.name} 失败: ${e.message ?? e}`);
                    invalid.push(artifact.name);
                }
            }),
        );

        console.log(`[Cron] 成功 ${valid.length} 个，失败 ${invalid.length} 个`);

        if (valid.length === 0) {
            console.error('[Cron] 全部失败，跳过上传');
            return;
        }

        // 上传到 Gist
        const resp = await syncToGist(files);
        const body = JSON.parse(resp.body);

        // 更新 artifact URL
        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source && valid.includes(artifact.name)) {
                artifact.updated = new Date().getTime();
                let gistFiles = body.files;
                let isGitLab;
                if (Array.isArray(gistFiles)) {
                    isGitLab = true;
                    gistFiles = Object.fromEntries(gistFiles.map((item) => [item.path, item]));
                }
                const raw_url = gistFiles[encodeURIComponent(artifact.name)]?.raw_url;
                artifact.url = isGitLab ? raw_url : raw_url?.replace(/\/raw\/[^/]*\/(.*)/, '/raw/$1');
            }
        }

        $.write(allArtifacts, ARTIFACTS_KEY);

        // Gist 备份上传
        try {
            console.log('[Cron] 上传 Gist 备份...');
            await gistBackupAction('upload');
            console.log('[Cron] Gist 备份完成');
        } catch (e) {
            console.error(`[Cron] Gist 备份失败: ${e.message ?? e}`);
        }

        await $.persistCache();
        console.log('[Cron] 同步完成');
    } catch (e) {
        console.error(`[Cron] 同步失败: ${e.message ?? e}`);
        // 尝试回写
        try { await $.persistCache(); } catch (_) {}
    }
}
