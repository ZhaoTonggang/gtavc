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

function fetchJS7zFile(fetch, onsuccess, onerror, onprogress, onreadystatechange) {
	var url = HEAPU32[fetch + 8 >> 2];
	if (!url) {
		// 无URL时：触发错误+直接返回，不重复处理
		onerror(fetch);
		return
	}
	var filePath = UTF8ToString(url).replace('https://cdn.dos.zone/vcsky', '');
	var fetch_attr = fetch + 108;
	var fetchAttributes = HEAPU32[fetch_attr + 52 >> 2];
	var fetchAttrLoadToMemory = !!(fetchAttributes & 1);
	var fetchAttrSynchronous = !!(fetchAttributes & 64);
	var id = Fetch.xhrs.allocate({
		path: filePath,
		status: "pending"
	});
	HEAPU32[fetch >> 2] = id;
	// 句柄校验函数
	function checkHandleValid() {
		if (!Fetch.xhrs.has(id)) {
			console.warn(`File read handle ${id} is invalid, skip callback`);
			return false;
		}
		return true;
	}

	function saveResponseAndStatus(data) {
		var ptr = 0;
		var ptrLen = 0;
		if (data && fetchAttrLoadToMemory && HEAPU32[fetch + 12 >> 2] === 0) ptrLen = data.byteLength;
		if (ptrLen > 0) {
			ptr = _realloc(HEAPU32[fetch + 12 >> 2], ptrLen);
			HEAPU8.set(new Uint8Array(data), ptr)
		}
		HEAPU32[fetch + 12 >> 2] = ptr;
		writeI53ToI64(fetch + 16, ptrLen);
		writeI53ToI64(fetch + 24, 0);
		writeI53ToI64(fetch + 32, data ? data.byteLength : 0);
		HEAP16[fetch + 40 >> 1] = 4;
		HEAP16[fetch + 42 >> 1] = 200;
		stringToUTF8("OK", fetch + 44, 64);
		if (fetchAttrSynchronous) {
			var ruPtr = stringToNewUTF8(filePath);
			HEAPU32[fetch + 200 >> 2] = ruPtr
		}
	}
	var arrayBuffer = null;
	try {
		// 先校验句柄（防止已释放的请求继续执行）
		if (!checkHandleValid()) return;
		var fileData = js7z.FS.readFile(filePath.includes('\\') ? filePath.replace(/\\/g, '/') : filePath);
		if (fileData instanceof Uint8Array) {
			arrayBuffer = fileData.buffer;
		} else if (fileData instanceof ArrayBuffer) {
			arrayBuffer = fileData;
		} else {
			arrayBuffer = new TextEncoder().encode(fileData).buffer;
		}
		onprogress(fetch);
		onreadystatechange(fetch);
		saveResponseAndStatus(arrayBuffer);
		onsuccess(fetch);
		Fetch.xhrs.free(id)
	} catch (e) {
		// 失败时：先校验句柄→触发错误回调→释放句柄
		if (!checkHandleValid()) return;
		onprogress(fetch);
		onreadystatechange(fetch);
		saveResponseAndStatus(arrayBuffer);
		onerror(fetch);
		Fetch.xhrs.free(id)
	} finally {
		// if (checkHandleValid()) Fetch.xhrs.free(id); // 释放句柄，阻止重复回调
	}
}

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
			f()
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
		fetchCacheData(Fetch.dbInstance, fetch, fileObj.response, storeSuccess, storeError)
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
		return 0
	}
	return fetch
}