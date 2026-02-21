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
			Fetch.dbInstance = db
		} catch (e) {
			Fetch.dbInstance = false
		} finally {
			removeRunDependency("library_fetch_init")
		}
	}
};

// 路径标准化工具函数 - 统一斜杠、去除多余分隔符、处理绝对/相对路径
function normalizePath(path) {
	if (!path) return path;
	return path
		.replace(/\\+/g, '/') // 所有反斜杠替换为正斜杠
		.replace(/\/+/g, '/') // 多个正斜杠合并为一个
		.replace(/^\/+/, '') // 移除开头多余的正斜杠（适配js7z相对路径）
		.replace(/\/$/, ''); // 移除结尾多余的正斜杠
}

// fetchXHR函数（路径标准化+js7z读取兜底+错误细化）
function fetchXHR(fetch, onsuccess, onerror, onprogress, onreadystatechange) {
	var url = HEAPU32[fetch + 8 >> 2];
	if (!url) {
		onerror(fetch, "no url specified!");
		return;
	}
	// 标准化路径 - 解决混合斜杠问题
	var rawUrl = UTF8ToString(url);
	var url_ = normalizePath(rawUrl.replace('https://cdn.dos.zone/vcsky', ''));
	var fetch_attr = fetch + 108;
	var fetchAttributes = HEAPU32[fetch_attr + 52 >> 2];
	var fetchAttrLoadToMemory = !!(fetchAttributes & 1);
	var fetchAttrSynchronous = !!(fetchAttributes & 64);

	// 分配ID
	var id = Fetch.xhrs.allocate({
		url: url_,
		rawUrl: rawUrl
	});
	HEAPU32[fetch >> 2] = id;

	// 模拟readyStateChange回调
	function triggerReadyStateChange(readyState, status = 200) {
		HEAP16[fetch + 40 >> 1] = readyState;
		if (readyState >= 2) {
			HEAP16[fetch + 42 >> 1] = status;
		}
		onreadystatechange && onreadystatechange(fetch, {
			type: 'readystatechange'
		});
	}

	// 模拟进度回调
	function triggerProgress(total) {
		if (!onprogress) return;
		var ptrLen = fetchAttrLoadToMemory ? total : 0;
		var ptr = 0;
		if (ptrLen > 0) {
			ptr = _realloc(HEAPU32[fetch + 12 >> 2], ptrLen);
		}
		HEAPU32[fetch + 12 >> 2] = ptr;
		writeI53ToI64(fetch + 16, ptrLen);
		writeI53ToI64(fetch + 24, total - ptrLen);
		writeI53ToI64(fetch + 32, total);
		HEAP16[fetch + 40 >> 1] = 3; // LOADING状态
		HEAP16[fetch + 42 >> 1] = 200;
		onprogress(fetch, {
			loaded: total,
			total: total
		});
	}

	// 保存响应数据
	function saveResponseAndStatus(data) {
		var ptr = 0;
		var ptrLen = 0;
		if (data && fetchAttrLoadToMemory && HEAPU32[fetch + 12 >> 2] === 0) {
			ptrLen = data.byteLength || 0;
		}
		if (ptrLen > 0) {
			ptr = _realloc(HEAPU32[fetch + 12 >> 2], ptrLen);
			HEAPU8.set(new Uint8Array(data), ptr);
		}
		HEAPU32[fetch + 12 >> 2] = ptr;
		writeI53ToI64(fetch + 16, ptrLen);
		writeI53ToI64(fetch + 24, 0);
		var len = data ? (data.byteLength || 0) : 0;
		if (len) {
			writeI53ToI64(fetch + 32, len);
		}
		HEAP16[fetch + 40 >> 1] = 4; // DONE状态
		if (data) {
			HEAP16[fetch + 42 >> 1] = 200;
			stringToUTF8("OK", fetch + 44, 64);
		} else {
			HEAP16[fetch + 42 >> 1] = 404;
			stringToUTF8("File not found", fetch + 44, 64);
		}
		if (fetchAttrSynchronous) {
			var ruPtr = stringToNewUTF8(url_);
			HEAPU32[fetch + 200 >> 2] = ruPtr;
		}
	}

	// 模拟XHR的状态变化流程
	triggerReadyStateChange(1); // OPENED
	triggerReadyStateChange(2); // HEADERS_RECEIVED

	try {
		// 标准化后再调用js7z.FS.readFile
		var fileData = js7z.FS.readFile(url_);
		// 数据格式强适配：确保转为ArrayBuffer，兼容js7z不同返回格式
		var arrayBuffer;
		if (fileData instanceof ArrayBuffer) {
			arrayBuffer = fileData;
		} else if (fileData instanceof Uint8Array) {
			arrayBuffer = fileData.buffer;
		} else if (typeof fileData === 'string') {
			arrayBuffer = new TextEncoder().encode(fileData).buffer;
		} else {
			throw new Error(`Unsupported file data type for ${url_}`);
		}

		// 触发进度和完成回调
		triggerProgress(arrayBuffer.byteLength);
		triggerReadyStateChange(3); // LOADING
		saveResponseAndStatus(arrayBuffer);
		triggerReadyStateChange(4); // DONE
		onsuccess && onsuccess(fetch, {
			response: arrayBuffer,
			status: 200,
			statusText: "OK"
		}, {
			type: 'load'
		});

	} catch (e) {
		// 细化错误类型，避免无意义重试
		saveResponseAndStatus(null);
		// 明确抛出路径/文件相关错误，方便上层排查
		const errorMsg = `js7z read fail: ${url_}, raw: ${rawUrl}, reason: ${e.message}`;
		console.error(errorMsg); // 控制台打印详细错误，便于调试
		onerror && onerror(fetch, new Error(errorMsg));
	}
}

function fetchCacheData(db, fetch, data, onsuccess, onerror) {
	if (!db) {
		onerror(fetch, 0, "IndexedDB not available!");
		return;
	}
	var fetch_attr = fetch + 108;
	var destinationPath = HEAPU32[fetch_attr + 64 >> 2];
	destinationPath ||= HEAPU32[fetch + 8 >> 2];
	var destinationPathStr = normalizePath(UTF8ToString(destinationPath)); // 路径标准化
	try {
		var transaction = db.transaction(["FILES"], "readwrite");
		var packages = transaction.objectStore("FILES");
		var putRequest = packages.put(data, destinationPathStr);
		putRequest.onsuccess = event => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 200;
			stringToUTF8("OK", fetch + 44, 64);
			onsuccess(fetch, 0, destinationPathStr);
		};
		putRequest.onerror = error => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 413;
			stringToUTF8("Payload Too Large", fetch + 44, 64);
			onerror(fetch, 0, error);
		};
	} catch (e) {
		onerror(fetch, 0, e);
	}
}

function fetchLoadCachedData(db, fetch, onsuccess, onerror) {
	if (!db) {
		onerror(fetch, 0, "IndexedDB not available!");
		return;
	}
	var fetch_attr = fetch + 108;
	var path = HEAPU32[fetch_attr + 64 >> 2];
	path ||= HEAPU32[fetch + 8 >> 2];
	var pathStr = normalizePath(UTF8ToString(path)); // 路径标准化
	try {
		var transaction = db.transaction(["FILES"], "readonly");
		var packages = transaction.objectStore("FILES");
		var getRequest = packages.get(pathStr);
		getRequest.onsuccess = event => {
			if (event.target.result) {
				var value = event.target.result;
				var len = value.byteLength || value.length || 0;
				var ptr = _malloc(len);
				HEAPU8.set(new Uint8Array(value), ptr);
				HEAPU32[fetch + 12 >> 2] = ptr;
				writeI53ToI64(fetch + 16, len);
				writeI53ToI64(fetch + 24, 0);
				writeI53ToI64(fetch + 32, len);
				HEAP16[fetch + 40 >> 1] = 4;
				HEAP16[fetch + 42 >> 1] = 200;
				stringToUTF8("OK", fetch + 44, 64);
				onsuccess(fetch, 0, value);
			} else {
				HEAP16[fetch + 40 >> 1] = 4;
				HEAP16[fetch + 42 >> 1] = 404;
				stringToUTF8("Not Found", fetch + 44, 64);
				onerror(fetch, 0, `Cache not found: ${pathStr}`);
			}
		};
		getRequest.onerror = error => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 404;
			stringToUTF8("Not Found", fetch + 44, 64);
			onerror(fetch, 0, error);
		};
	} catch (e) {
		onerror(fetch, 0, e);
	}
}

function fetchDeleteCachedData(db, fetch, onsuccess, onerror) {
	if (!db) {
		onerror(fetch, 0, "IndexedDB not available!");
		return;
	}
	var fetch_attr = fetch + 108;
	var path = HEAPU32[fetch_attr + 64 >> 2];
	path ||= HEAPU32[fetch + 8 >> 2];
	var pathStr = normalizePath(UTF8ToString(path)); // 路径标准化
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
			onsuccess(fetch, 0, value);
		};
		request.onerror = error => {
			HEAP16[fetch + 40 >> 1] = 4;
			HEAP16[fetch + 42 >> 1] = 404;
			stringToUTF8("Not Found", fetch + 44, 64);
			onerror(fetch, 0, error);
		};
	} catch (e) {
		onerror(fetch, 0, e);
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
			f();
		} else {
			callUserCallback(f);
		}
	}
	var reportSuccess = (fetch, xhr, e) => {
		doCallback(() => {
			if (onsuccess) getWasmTableEntry(onsuccess)(fetch);
			else successcb?.(fetch);
		});
	};
	var reportProgress = (fetch, e) => {
		doCallback(() => {
			if (onprogress) getWasmTableEntry(onprogress)(fetch);
			else progresscb?.(fetch);
		});
	};
	var reportError = (fetch, e) => {
		doCallback(() => {
			if (onerror) getWasmTableEntry(onerror)(fetch);
			else errorcb?.(fetch);
		});
	};
	var reportReadyStateChange = (fetch, e) => {
		doCallback(() => {
			if (onreadystatechange) getWasmTableEntry(onreadystatechange)(fetch);
			else readystatechangecb?.(fetch);
		});
	};
	var performUncachedXhr = (fetch, xhr, e) => {
		fetchXHR(fetch, reportSuccess, reportError, reportProgress, reportReadyStateChange);
	};
	var cacheResultAndReportSuccess = (fetch, xhr, e) => {
		var storeSuccess = (fetch, xhr, e) => {
			doCallback(() => {
				if (onsuccess) getWasmTableEntry(onsuccess)(fetch);
				else successcb?.(fetch);
			});
		};
		var storeError = (fetch, xhr, e) => {
			doCallback(() => {
				if (onsuccess) getWasmTableEntry(onsuccess)(fetch);
				else successcb?.(fetch);
			});
		};
		fetchCacheData(Fetch.dbInstance, fetch, xhr?.response, storeSuccess, storeError);
	};
	var performCachedXhr = (fetch, xhr, e) => {
		fetchXHR(fetch, cacheResultAndReportSuccess, reportError, reportProgress, reportReadyStateChange);
	};
	var requestMethod = UTF8ToString(fetch_attr + 0);
	var fetchAttrReplace = !!(fetchAttributes & 16);
	var fetchAttrPersistFile = !!(fetchAttributes & 4);
	var fetchAttrNoDownload = !!(fetchAttributes & 32);
	if (requestMethod === "EM_IDB_STORE") {
		var ptr = HEAPU32[fetch_attr + 84 >> 2];
		var size = HEAPU32[fetch_attr + 88 >> 2];
		fetchCacheData(Fetch.dbInstance, fetch, HEAPU8.slice(ptr, ptr + size), reportSuccess, reportError);
	} else if (requestMethod === "EM_IDB_DELETE") {
		fetchDeleteCachedData(Fetch.dbInstance, fetch, reportSuccess, reportError);
	} else if (!fetchAttrReplace) {
		fetchLoadCachedData(Fetch.dbInstance, fetch, reportSuccess, fetchAttrNoDownload ? reportError :
			fetchAttrPersistFile ? performCachedXhr : performUncachedXhr);
	} else if (!fetchAttrNoDownload) {
		fetchXHR(fetch, fetchAttrPersistFile ? cacheResultAndReportSuccess : reportSuccess, reportError, reportProgress,
			reportReadyStateChange);
	} else {
		return 0;
	}
	return fetch;
}