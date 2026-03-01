importScripts('./7z/js7z.js');
// 用于向主线程发送状态更新
const sendStatus = (message) => {
	self.postMessage({
		type: 'status',
		data: message
	});
}
// 用于向主线程发送错误
const sendError = (error) => {
	self.postMessage({
		type: 'error',
		error: error.message || error
	});
}
// 原有的分段执行函数
const runInSlices = async (task) => {
	const taskIterator = task();
	const executeSlice = async () => {
		let startTime = performance.now();
		let result;
		do {
			result = taskIterator.next();
			if (result.done) break;
		} while (performance.now() - startTime < 50);
		if (!result.done) {
			await new Promise(resolve => setTimeout(resolve, 10));
			return executeSlice();
		}
		return result.value;
	};
	return executeSlice();
};
let js7z = null;
// 核心处理函数
const process7zFile = async (zName, title, path) => {
	let cache = null;
	let buffer = null;
	try {
		// 初始化JS7z实例
		sendStatus('正在初始化...');
		js7z = await new Promise((resolve) => {
			setTimeout(async () => {
				const instance = await JS7z({
					locateFile: () => './7z/js7z.wasm',
					print: (str) => {
						if (str.trim().length > 0) {
							console.log(str);
							sendStatus(str);
						}
					},
					printErr: (str) => {
						if (str.trim().length > 0) {
							console.error(str);
							sendStatus(str);
						}
					},
					noExitRuntime: true
				});
				resolve(instance);
			}, 0);
		});
		if (!js7z) throw new Error('初始化失败！');
		// 打开缓存
		sendStatus('正在检查缓存...');
		cache = await caches.open('GameData');
		buffer = await cache.match(zName);
		// 缓存存在则直接使用
		if (buffer) {
			sendStatus("正在从缓存加载数据包");
			buffer = new Uint8Array(await buffer.arrayBuffer());
		} else {
			// 缓存不存在则下载文件
			sendStatus('开始下载数据包');
			const response = await fetch(path);
			if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
			const datalen = Number(response.headers.get('Content-Length')) || 0;
			const zdata = response.body.getReader();
			let chunks = [];
			let receivedLength = 0;
			// 流式下载
			while (true) {
				const {
					done,
					value
				} = await zdata.read();
				if (done) break;
				chunks.push(value);
				receivedLength += value.length;
				sendStatus(`${title}(${receivedLength}/${datalen})`);
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			// 分段拼接二进制数据
			buffer = new Uint8Array(receivedLength);
			sendStatus('正在合并数据...');
			await runInSlices(function*() {
				let position = 0;
				for (let chunk of chunks) {
					buffer.set(chunk, position);
					position += chunk.length;
					yield;
				}
			});
			// 写入缓存
			sendStatus("正在写入缓存");
			await cache.put(zName, new Response(buffer, {
				headers: {
					'Content-Type': 'application/x-7z-compressed',
					'Content-Length': datalen
				}
			}));
		}
		if (!buffer) throw new Error('压缩包数据为空');
		// 分块写入7z内存文件系统
		sendStatus("正在准备写入数据");
		await runInSlices(function*() {
			let stream = null;
			try {
				stream = js7z.FS.open(zName, 'w+');
				const chunkSize = 1024 * 1024; // 1MB/块
				const blen = buffer.length;
				let position = 0;
				while (position < blen) {
					const end = Math.min(position + chunkSize, blen);
					const chunk = buffer.subarray(position, end);
					js7z.FS.write(stream, chunk, 0, chunk.length);
					position = end;
					sendStatus(`正在写入数据...(${position}/${blen})`);
					yield;
				}
			} finally {
				if (stream) {
					js7z.FS.close(stream);
				}
			}
		});
		// 执行解压
		sendStatus("正在解压数据...");
		js7z.callMain(['x', zName, '-p2585649532', '-aoa', '-y']);
		// 通知主线程完成
	} catch (err) {
		sendError(err);
		throw err;
	} finally {
		// 清理资源
		if (js7z && js7z.FS && js7z.FS.analyzePath(zName).exists) {
			try {
				js7z.FS.unlink(zName);
			} catch (e) {
				console.error('清理7z文件失败：', e);
			}
		}
	}
}
// 监听主线程消息
self.onmessage = async function(e) {
	const {
		type,
		title,
		zName,
		path,
		fileName
	} = e.data;
	if (type === 'start' && zName && path) {
		try {
			await process7zFile(zName, title, path);
			// 解压完成后通知主线程
			self.postMessage({
				type: 'complete'
			});
		} catch (err) {
			sendError(err);
		}
	}
	if (type === 'readFile' && fileName && js7z) {
		try {
			// 支持任意文件路径的读取
			const normalizedFileName = fileName;
			const fileData = js7z.FS.readFile(normalizedFileName);
			// 发送给主线程（使用Transferable优化大文件传输）
			self.postMessage({
				type: 'fileData',
				data: {
					name: normalizedFileName,
					buffer: fileData.buffer
				}
			}, [fileData.buffer]); // Transferable标记，提升性能
		} catch (e) {
			sendError(new Error(`读取文件${fileName}失败: ${e.message}`));
			// 向主线程发送错误消息，让fetchJS7zFile能捕获
			self.postMessage({
				type: 'fileDataError',
				data: {
					name: fileName,
					error: e.message
				}
			});
		}
	}
};