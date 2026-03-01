let pendingFileReads;

function saveResponseAndStatus(fetch, data) {
	var fetch_attr = fetch + 108;
	var fetchAttributes = HEAPU32[fetch_attr + 52 >> 2];
	var fetchAttrLoadToMemory = !!(fetchAttributes & 1);
	var fetchAttrSynchronous = !!(fetchAttributes & 64);
	var oldPtr = HEAPU32[fetch + 12 >> 2];
	var ptr = 0;
	var ptrLen = 0;
	if (data && fetchAttrLoadToMemory && oldPtr === 0) {
		ptrLen = data.byteLength;
		// 预分配内存，减少realloc次数
		ptr = _malloc(ptrLen);
		HEAPU8.set(new Uint8Array(data), ptr);
		// 有旧指针则释放
		if (oldPtr !== 0) _free(oldPtr);
	}
	HEAPU32[fetch + 12 >> 2] = ptr;
	writeI53ToI64(fetch + 16, ptrLen);
	writeI53ToI64(fetch + 24, 0);
	writeI53ToI64(fetch + 32, data ? data.byteLength : 0);
	HEAP16[fetch + 40 >> 1] = 4;
	HEAP16[fetch + 42 >> 1] = 200;
	stringToUTF8("OK", fetch + 44, 64);
	if (fetchAttrSynchronous) {
		var normalizedFilePath = UTF8ToString(HEAPU32[fetch + 8 >> 2]).replace('https://cdn.dos.zone/vcsky', '')
			.replace(/\\/g, '/');
		var ruPtr = stringToNewUTF8(normalizedFilePath);
		HEAPU32[fetch + 200 >> 2] = ruPtr;
		// 及时释放临时字符串指针
		setTimeout(() => {
			if (ruPtr !== 0) _free(ruPtr);
		}, 0);
	}
}

function fetchJS7zFile(fetch, onsuccess, onerror, onprogress, onreadystatechange) {
	var url = HEAPU32[fetch + 8 >> 2];
	if (!url) {
		onerror(fetch);
		return;
	}
	var filePath = UTF8ToString(url).replace('https://cdn.dos.zone/vcsky', '');
	var normalizedFilePath = filePath.replace(/\\/g, '/');
	var fetch_attr = fetch + 108;
	var fetchAttributes = HEAPU32[fetch_attr + 52 >> 2];
	var fetchAttrSynchronous = !!(fetchAttributes & 64);
	// 分配句柄
	var id = Fetch.xhrs.allocate({
		path: normalizedFilePath,
		status: "pending"
	});
	HEAPU32[fetch >> 2] = id;
	// 同步标记下立即触发readyStateChange
	if (fetchAttrSynchronous) {
		onreadystatechange(fetch);
	}
	// 将回调加入pending队列
	if (!pendingFileReads[normalizedFilePath]) {
		pendingFileReads[normalizedFilePath] = [];
		// 发送读取指令到worker
		global7zWorker.postMessage({
			type: 'readFile',
			fileName: normalizedFilePath
		});
	}
	// 加入回调队列
	pendingFileReads[normalizedFilePath].push({
		fetch,
		onsuccess,
		onerror,
		onprogress,
		onreadystatechange
	});
}
var Fetch = {
	async openDatabase(dbname, dbversion) {
		return new Promise((resolve, reject) => {
			try {
				var openRequest = indexedDB.open(dbname, dbversion)
			} catch (e) {
				return reject(e)
			}
			openRequest.onupgradeneeded = event => {
				var db = event.target.result;
				if (db.objectStoreNames.contains("FILES")) {
					db.deleteObjectStore("FILES")
				}
				db.createObjectStore("FILES")
			};
			openRequest.onsuccess = event => resolve(event.target.result);
			openRequest.onerror = reject
		})
	},
	async init() {
		Fetch.xhrs = new HandleAllocator;
		addRunDependency("library_fetch_init");
		try {
			var db = await Fetch.openDatabase("emscripten_filesystem", 1);
			Fetch.dbInstance = db;
			// 初始化Worker全局监听
			global7zWorker.addEventListener('message', (msg) => {
				const {
					type,
					data
				} = msg.data;
				// 只处理文件相关消息
				if (type !== 'fileData' && type !== 'fileDataError') return;
				const fileName = data.name;
				// 查找当前等待该文件的回调队列
				const pendingCallbacks = pendingFileReads[fileName];
				if (!pendingCallbacks) return;
				// 遍历执行所有等待该文件的回调
				pendingCallbacks.forEach(({
					fetch,
					onsuccess,
					onerror,
					onprogress,
					onreadystatechange
				}) => {
					const checkHandleValid = () => {
						const id = HEAPU32[fetch >> 2];
						return Fetch.xhrs.has(id);
					};
					if (!checkHandleValid()) return;
					if (type === 'fileDataError') {
						// 错误时arrayBuffer设为null
						const arrayBuffer = null;
						onprogress(fetch);
						onreadystatechange(fetch);
						saveResponseAndStatus(fetch, arrayBuffer); // 抽离save函数
						onerror(fetch);
					} else {
						try {
							const arrayBuffer = data.buffer;
							onprogress(fetch);
							onreadystatechange(fetch);
							saveResponseAndStatus(fetch, arrayBuffer);
							onsuccess(fetch);
						} catch (e) {
							const arrayBuffer = null;
							onprogress(fetch);
							onreadystatechange(fetch);
							saveResponseAndStatus(fetch, arrayBuffer);
							onerror(fetch);
						}
					}
					// 释放句柄
					const id = HEAPU32[fetch >> 2];
					if (checkHandleValid()) Fetch.xhrs.free(id);
				});
				// 执行完后清空该文件的等待队列
				delete pendingFileReads[fileName];
			});
			// 全局错误监听
			global7zWorker.addEventListener('error', (err) => {
				console.error('Worker全局错误:', err);
				// 清空所有pending队列，避免挂起
				Object.keys(pendingFileReads).forEach(fileName => {
					const pendingCallbacks = pendingFileReads[fileName];
					pendingCallbacks.forEach(({
						fetch,
						onerror,
						onprogress,
						onreadystatechange
					}) => {
						const arrayBuffer = null;
						onprogress(fetch);
						onreadystatechange(fetch);
						saveResponseAndStatus(fetch, arrayBuffer);
						onerror(fetch);
						const id = HEAPU32[fetch >> 2];
						if (Fetch.xhrs.has(id)) Fetch.xhrs.free(id);
					});
				});
				pendingFileReads = {};
			});
			pendingFileReads = {};
		} catch (e) {
			Fetch.dbInstance = false
		} finally {
			removeRunDependency("library_fetch_init")
		}
	}
};

function fetchCacheData(db, fetch, data, onsuccess, onerror) {
	if (!db) {
		onerror(fetch, 0, "IndexedDB not available!");
		return
	}
	var fetch_attr = fetch + 108;
	var destinationPath = HEAPU32[fetch_attr + 64 >> 2];
	destinationPath ||= HEAPU32[fetch + 8 >> 2];
	var destinationPathStr = UTF8ToString(destinationPath);
	try {
		var transaction = db.transaction(["FILES"], "readwrite");
		var packages = transaction.objectStore("FILES");
		var putRequest = packages.put(data, destinationPathStr);
		putRequest.onsuccess = () => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 200;
			stringToUTF8("OK", fetch + 44, 64);
			onsuccess(fetch, 0, destinationPathStr)
		};
		putRequest.onerror = error => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 413;
			stringToUTF8("Payload Too Large", fetch + 44, 64);
			onerror(fetch, 0, error)
		}
	} catch (e) {
		onerror(fetch, 0, e)
	}
}

function fetchLoadCachedData(db, fetch, onsuccess, onerror) {
	if (!db) {
		onerror(fetch, 0, "IndexedDB not available!");
		return
	}
	var fetch_attr = fetch + 108;
	var path = HEAPU32[fetch_attr + 64 >> 2];
	path ||= HEAPU32[fetch + 8 >> 2];
	var pathStr = UTF8ToString(path);
	try {
		var transaction = db.transaction(["FILES"], "readonly");
		var packages = transaction.objectStore("FILES");
		var getRequest = packages.get(pathStr);
		getRequest.onsuccess = event => {
			if (event.target.result) {
				var value = event.target.result;
				var len = value.byteLength || value.length;
				var ptr = _malloc(len);
				HEAPU8.set(new Uint8Array(value), ptr);
				HEAPU32[fetch + 12 >> 2] = ptr;
				writeI53ToI64(fetch + 16, len);
				writeI53ToI64(fetch + 24, 0);
				writeI53ToI64(fetch + 32, len);
				HEAP16[fetch + 40 >> 1] = 4;
				HEAP16[fetch + 42 >> 1] = 200;
				stringToUTF8("OK", fetch + 44, 64);
				onsuccess(fetch, 0, value)
			} else {
				HEAP16[fetch + 40 >> 1] = 4;
				HEAP16[fetch + 42 >> 1] = 404;
				stringToUTF8("Not Found", fetch + 44, 64);
				onerror(fetch, 0, "no data")
			}
		};
		getRequest.onerror = error => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 404;
			stringToUTF8("Not Found", fetch + 44, 64);
			onerror(fetch, 0, error)
		}
	} catch (e) {
		onerror(fetch, 0, e)
	}
}

function fetchDeleteCachedData(db, fetch, onsuccess, onerror) {
	if (!db) {
		onerror(fetch, 0, "IndexedDB not available!");
		return
	}
	var fetch_attr = fetch + 108;
	var path = HEAPU32[fetch_attr + 64 >> 2];
	path ||= HEAPU32[fetch + 8 >> 2];
	var pathStr = UTF8ToString(path);
	try {
		var transaction = db.transaction(["FILES"], "readwrite");
		var packages = transaction.objectStore("FILES");
		var request = packages.delete(pathStr);
		request.onsuccess = event => {
			var value = event.target.result;
			HEAPU32[fetch + 12 >> 2] = 0;
			writeI53ToI64(fetch + 16, 0);
			writeI53ToI64(fetch + 24, 0);
			writeI53ToI64(fetch + 32, 0);
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 200;
			stringToUTF8("OK", fetch + 44, 64);
			onsuccess(fetch, 0, value)
		};
		request.onerror = error => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 404;
			stringToUTF8("Not Found", fetch + 44, 64);
			onerror(fetch, 0, error)
		}
	} catch (e) {
		onerror(fetch, 0, e)
	}
}

function _emscripten_start_fetch(fetch, successcb, errorcb, progresscb, readystatechangecb) {
	var fetch_attr = fetch + 108;
	var onsuccess = HEAPU32[fetch_attr + 36 >> 2];
	var onerror = HEAPU32[fetch_attr + 40 >> 2];
	var onprogress = HEAPU32[fetch_attr + 44 >> 2];
	var onreadystatechange = HEAPU32[fetch_attr + 48 >> 2];
	var fetchAttributes = HEAPU32[fetch_attr + 52 >> 2];
	var fetchAttrSynchronous = !!(fetchAttributes & 64);

	function doCallback(f) {
		if (fetchAttrSynchronous) {
			// 如果浏览器支持微任务，则同步标记下使用微任务执行，避免阻塞主线程
			queueMicrotask ? queueMicrotask(f) : f()
		} else {
			callUserCallback(f)
		}
	}
	var reportSuccess = (fetch) => {
		doCallback(() => {
			if (onsuccess) {
				getWasmTableEntry(onsuccess)(fetch)
			} else {
				successcb?.(fetch)
			}
		})
	};
	var reportProgress = (fetch) => {
		doCallback(() => {
			if (onprogress) {
				getWasmTableEntry(onprogress)(fetch)
			} else {
				progresscb?.(fetch)
			}
		})
	};
	var reportError = (fetch) => {
		doCallback(() => {
			if (onerror) {
				getWasmTableEntry(onerror)(fetch)
			} else {
				errorcb?.(fetch)
			}
		})
	};
	var reportReadyStateChange = (fetch) => {
		doCallback(() => {
			if (onreadystatechange) {
				getWasmTableEntry(onreadystatechange)(fetch)
			} else {
				readystatechangecb?.(fetch)
			}
		})
	};
	var performUncachedFileRead = (fetch) => {
		fetchJS7zFile(fetch, reportSuccess, reportError, reportProgress, reportReadyStateChange)
	};
	var cacheResultAndReportSuccess = (fetch, fileObj) => {
		var storeSuccess = (fetch) => {
			doCallback(() => {
				if (onsuccess) {
					getWasmTableEntry(onsuccess)(fetch)
				} else {
					successcb?.(fetch)
				}
			})
		};
		var storeError = (fetch) => {
			doCallback(() => {
				if (onsuccess) {
					getWasmTableEntry(onsuccess)(fetch)
				} else {
					successcb?.(fetch)
				}
			})
		};
		var fileData = fileObj instanceof ArrayBuffer ? fileObj : (fileObj?.response || fileObj || null);
		fetchCacheData(Fetch.dbInstance, fetch, fileData, storeSuccess, storeError)
	};
	var performCachedFileRead = (fetch) => {
		fetchJS7zFile(fetch, cacheResultAndReportSuccess, reportError, reportProgress, reportReadyStateChange)
	};
	var requestMethod = UTF8ToString(fetch_attr + 0);
	var fetchAttrReplace = !!(fetchAttributes & 16);
	var fetchAttrPersistFile = !!(fetchAttributes & 4);
	var fetchAttrNoDownload = !!(fetchAttributes & 32);
	if (requestMethod === "EM_IDB_STORE") {
		var ptr = HEAPU32[fetch_attr + 84 >> 2];
		var size = HEAPU32[fetch_attr + 88 >> 2];
		fetchCacheData(Fetch.dbInstance, fetch, HEAPU8.slice(ptr, ptr + size), reportSuccess, reportError)
	} else if (requestMethod === "EM_IDB_DELETE") {
		fetchDeleteCachedData(Fetch.dbInstance, fetch, reportSuccess, reportError)
	} else if (!fetchAttrReplace) {
		fetchLoadCachedData(Fetch.dbInstance, fetch, reportSuccess, fetchAttrNoDownload ? reportError :
			fetchAttrPersistFile ? performCachedFileRead : performUncachedFileRead)
	} else if (!fetchAttrNoDownload) {
		fetchJS7zFile(fetch, fetchAttrPersistFile ? cacheResultAndReportSuccess : reportSuccess, reportError,
			reportProgress, reportReadyStateChange)
	} else {
		// 无下载权限时主动触发错误，保证流程继续
		reportError(fetch);
		return 0
	}
	return fetch
}