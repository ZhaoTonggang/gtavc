'use strict';
// 版本
const Ver = 1778828876,
	cName = 'PWA-';
// 安装：缓存资源 + 立即激活
self.addEventListener('install', e => {
	e.waitUntil((async () => {
		try {
			// 打开缓存并缓存所有资源
			await (await caches.open(cName + Ver)).addAll([
				'./',
				'./404.html',
				'./favicon.ico',
				'./index.html',
				'./manifest.json',
				'./modules/asm_consts/en.js',
				'./modules/asm_consts/ru.js',
				'./modules/audio.js',
				'./modules/cheats.js',
				'./modules/events.js',
				'./modules/fetch.js',
				'./modules/fs.js',
				'./modules/graphics.js',
				'./modules/loader.js',
				'./modules/main.js',
				'./modules/packages/en.js',
				'./modules/packages/ru.js',
				'./modules/runtime.js',
				'./modules/syscalls.js',
				'./script/7z/js7z.js',
				'./script/7z/js7z.wasm',
				'./script/jsdos-cloud-sdk-local.js',
				'./script/jsdos-cloud-sdk.js',
				'./script/script.js',
				'./script/worker.js',
				'./style.css',
				'./vcsky/cover.jpg',
				'./vcsky/icons/1024.png',
				'./vcsky/icons/144.png',
				'./vcsky/icons/180.png',
				'./vcsky/icons/192.png',
				'./vcsky/icons/512.png',
				'./vcsky/icons/72.png',
				'./vcsky/icons/a144.png',
				'./vcsky/icons/a192.png',
				'./vcsky/icons/a48.png',
				'./vcsky/icons/a512.png',
				'./vcsky/icons/a72.png',
				'./vcsky/icons/a96.png',
				'./vcsky/intro.mp4',
				'./vcsky/wasted.png'
			]);
			// 跳过等待，直接激活新SW
			await self.skipWaiting();
		} catch (error) {
			console.error('❌ SW安装失败:', error);
			// 安装失败时重新抛出错误
			throw error;
		}
	})());
});
// 激活：删除旧缓存 + 控制页面 + 发送更新消息
self.addEventListener('activate', e => {
	e.waitUntil((async () => {
		try {
			// 删除非当前版本的缓存
			await Promise.all((await caches.keys()).filter(n => n.startsWith(cName)).map(n =>
				caches.delete(n)));
			// 立即控制所有页面
			await self.clients.claim();
			// 向页面发送缓存更新消息
			(await self.clients.matchAll({
				includeUncontrolled: 1,
				type: 'window'
			}))
			.forEach(c => c.postMessage({
				type: 'CACHE_UPDATED',
				version: Ver
			}));
		} catch (error) {
			console.error('❌ SW激活失败:', error);
			throw error;
		}
	})());
});
// 接收页面消息：触发SKIP_WAITING更新
self.addEventListener('message', e => e.data === 'SKIP_WAITING' && self.skipWaiting());
// 拦截请求：缓存优先 + 离线支持 + 状态通知
self.addEventListener('fetch', e => {
	const req = e.request;
	// 对于 Range 请求或 7z 数据文件，直接绕过 Service Worker
	if (req.headers.has('Range') || req.url.includes('.7z') || req.method !== 'GET' || !req.url.startsWith(
			'http')) return;
	// 判断是否为HTML页面请求
	const accept = req.headers.get('accept'),
		isHTML = req.destination === 'document' || (accept && accept.includes('text/html')),
		postMess = async (t, s) => {
			setTimeout(async () => {
				(await self.clients.matchAll({
					includeUncontrolled: 1,
					type: 'window'
				})).forEach(c => c.postMessage({
					type: t,
					status: s,
					version: Ver
				}));
			}, 1000)
		};
	e.respondWith((async () => {
		try {
			// 读取缓存
			const cacheRes = await caches.match(req, {
				ignoreSearch: true
			});
			if (cacheRes) {
				// HTML请求：延迟发送缓存命中消息
				if (isHTML) await postMess('CACHE_STATUS', 'HIT');
				return cacheRes;
			}
			// HTML请求：延迟发送缓存命中消息
			if (isHTML) await postMess('CACHE_STATUS', 'MISS');
			// 缓存未命中，请求网络
			const networkRes = await fetch(req);
			// 提前克隆响应，避免body重复使用
			const cloneRes = networkRes.clone();
			// 异步缓存资源，只缓存 HTTP/HTTPS 请求且有效响应
			if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') caches
				.open(cName + Ver).then(cache => cache.put(req, cloneRes));
			return networkRes;
		} catch (err) {
			// 网络异常：离线模式处理
			if (isHTML) {
				// 发送离线状态消息
				await postMess('CACHE_STATUS', 'OFFLINE');
				// 返回离线页面
				return await caches.match('./index.html') ?? new Response(
					'离线模式：无法加载页面', {
						status: 503,
						headers: {
							'Content-Type': 'text/plain; charset=utf-8'
						}
					}
				);
			}
			// 非HTML请求返回网络错误
			return new Response('Network error', {
				status: 503
			});
		}
	})());
});