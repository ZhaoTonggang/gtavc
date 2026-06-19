importScripts('./7z/js7z.js');
// 定义数据块大小
const chunkSize = 1024 * 1024; // 1MB/块
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
// 辅助函数：格式化字节数（KB/MB）
const formatBytes = (bytes) => {
	if (bytes === 0) return '0 KB';
	const k = 1024;
	// 先将字节转换为 KB
	const kb = bytes / k;
	// 限制单位范围：仅 KB 和 MB
	if (kb < k) {
		// 小于 1024 KB，显示 KB
		return kb.toFixed(2) + ' KB';
	} else {
		// 大于等于 1024 KB，显示 MB
		return (kb / k).toFixed(2) + ' MB';
	}
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
	}
	return executeSlice();
}
// 分片下载核心函数（支持进度回调）
const downloadSlice = async (path, start, end, index, title, progressTracker, progressCallback = null) => {
	try {
		const response = await fetch(path, {
			headers: {
				'Range': `bytes=${start}-${end}`
			}
		});
		if (!response.ok) throw new Error(`分片${index+1}下载失败：${response.status} ${response.statusText}`);
		const reader = response.body.getReader();
		let chunks = [];
		let sliceReceivedLength = 0;
		while (true) {
			const {
				done,
				value
			} = await reader.read();
			if (done) break;
			chunks.push(value);
			sliceReceivedLength += value.length;
			progressTracker.totalReceived += value.length;
			// 优先使用回调，否则使用默认行为
			if (progressCallback) {
				progressCallback(progressTracker.totalReceived, progressTracker.totalSize);
			} else {
				sendStatus(`${title}(${progressTracker.totalReceived}/${progressTracker.totalSize})`);
			}
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		const sliceBuffer = new Uint8Array(sliceReceivedLength);
		let position = 0;
		for (const chunk of chunks) {
			sliceBuffer.set(chunk, position);
			position += chunk.length;
		}
		return {
			index,
			buffer: sliceBuffer
		}
	} catch (err) {
		sendError(new Error(`分片${index+1}下载出错：${err.message}`));
		throw err;
	}
}
// 控制并发下载分片（支持进度回调）
const downloadWithSlices = async (path, title, progressCallback = null) => {
	// 发送HEAD请求获取文件信息
	const headResponse = await fetch(path, {
		method: 'HEAD'
	});
	if (!headResponse.ok) throw new Error(`获取文件信息失败：${headResponse.status} ${headResponse.statusText}`);
	const totalSize = Number(headResponse.headers.get('Content-Length')) || 0;
	if (totalSize) {
		// 支持分片下载
		const totalSlices = Math.ceil(totalSize / chunkSize);
		const progressTracker = {
			totalReceived: 0,
			totalSize: totalSize
		}
		const sliceTasks = [];
		for (let i = 0; i < totalSlices; i++) {
			const start = i * chunkSize;
			const end = Math.min(start + chunkSize - 1, totalSize - 1);
			sliceTasks.push(downloadSlice(path, start, end, i, title, progressTracker, progressCallback));
		}
		const sliceResults = await Promise.all(sliceTasks);
		sliceResults.sort((a, b) => a.index - b.index);
		const buffer = new Uint8Array(totalSize);
		let position = 0;
		await runInSlices(function*() {
			for (const slice of sliceResults) {
				buffer.set(slice.buffer, position);
				position += slice.buffer.length;
				yield;
			}
		});
		return {
			buffer,
			datalen: totalSize
		}
	}
	// 回退到单线程下载
	sendStatus('服务器不支持分片下载，将使用单线程下载');
	const response = await fetch(path);
	if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
	const zdata = response.body.getReader();
	let chunks = [];
	let totalReceived = 0;
	while (true) {
		const {
			done,
			value
		} = await zdata.read();
		if (done) break;
		chunks.push(value);
		totalReceived += value.length;
		// 调用进度回调
		if (progressCallback) {
			progressCallback(totalReceived, totalSize);
		} else {
			sendStatus(`${title}(${totalReceived}/${totalSize})`);
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	const buffer = new Uint8Array(totalReceived);
	let position = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, position);
		position += chunk.length;
	}
	return {
		buffer,
		datalen: totalSize
	}
}
let js7z = null;
// 监听主线程消息
self.onmessage = async function(e) {
	const {
		type,
		title,
		zName,
		path,
		paths,
		fileName
	} = e.data;
	if (type === 'start' && zName && (path || paths)) {
		// 核心处理函数（支持多7z分片文件）
		try {
			let cache = null;
			let buffer = null;
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
				let downloadResult;
				// 判断是单个文件还是多分片文件
				if (paths && paths.length > 0) {
					// 使用多分片下载
					const pathlen = paths.length;
					sendStatus(`准备下载 ${pathlen} 个分卷文件...`);
					const fileSizes = []; // 保存每个分卷的大小
					let totalSize = 0;
					let allBuffers = [];
					let accumulatedReceived = 0; // 所有分卷总共已下载字节
					// 获取所有文件大小
					for (let i = 0; i < pathlen; i++) {
						try {
							const headResponse = await fetch(paths[i], {
								method: 'HEAD'
							});
							const size = Number(headResponse.headers.get('Content-Length')) || 0;
							fileSizes.push(size);
							totalSize += size;
						} catch (err) {
							fileSizes.push(0);
							sendStatus(`获取分卷${i+1}信息失败，继续尝试下载...`);
						}
					}
					sendStatus(`总大小: ${formatBytes(totalSize)}, ${pathlen} 个分卷`);
					// 开始下载每个分卷
					for (let i = 0; i < pathlen; i++) {
						// 创建进度回调函数，计算总体进度
						const progressCallback = (receivedForFile) => {
							const totalReceived = accumulatedReceived + receivedForFile;
							sendStatus(`${title} [${i+1}/${pathlen}] ` +
								`(${totalReceived}/${totalSize})`);
						}
						const downloadResult = await downloadWithSlices(paths[i], `分卷${i+1}`,
							progressCallback);
						allBuffers.push(downloadResult.buffer);
						accumulatedReceived += downloadResult.datalen;
					}
					// 合并所有分卷
					sendStatus(`正在合并 ${pathlen} 个分卷...`);
					const mergedBuffer = new Uint8Array(totalSize);
					let position = 0;
					await runInSlices(function*() {
						for (let i = 0; i < allBuffers.length; i++) {
							mergedBuffer.set(allBuffers[i], position);
							position += allBuffers[i].length;
							sendStatus(`合并分卷 (${position}/${totalSize})`);
							yield;
						}
					});
					downloadResult = {
						buffer: mergedBuffer,
						datalen: totalSize
					}
				} else {
					// 使用原来的单个文件分片下载
					downloadResult = await downloadWithSlices(path, title);
				}
				buffer = downloadResult.buffer;
				// 写入缓存
				sendStatus("正在写入缓存");
				await cache.put(zName, new Response(buffer, {
					headers: {
						'Content-Type': 'application/x-7z-compressed',
						'Content-Length': downloadResult.datalen
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
			self.postMessage({
				type: 'complete'
			});
		} catch (err) {
			sendError(err);
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
	if (type === 'readFile' && fileName && js7z) {
		try {
			// 支持任意文件路径的读取
			const normalizedFileName = fileName;
			const fileData = js7z.FS.readFile(normalizedFileName).buffer;
			// 发送给主线程
			self.postMessage({
				type: 'fileData',
				data: {
					name: normalizedFileName,
					fileData: fileData
				}
			}, [fileData]); // Transferable标记，提升性能
		} catch (e) {
			sendError(new Error(`读取文件${fileName}失败: ${e.message}`));
			// 向主线程发送错误消息
			sendError(err);
			throw err;
		}
	}
}