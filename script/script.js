"use strict";
// 阻止默认事件
document.addEventListener('contextmenu', (event) => {
	event.preventDefault();
});
const textDecoder = new TextDecoder();
/* gamepad模块开始 */
const defineProperty = Object.defineProperty;
const setProperty = (obj, key, value) => key in obj ? defineProperty(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value: value
}) : obj[key] = value;
const mergeObjects = (target, source) => {
	let src = source || (source = {});
	for (let key in src) {
		if (Object.prototype.hasOwnProperty.call(src, key)) {
			setProperty(target, key, src[key]);
		}
	}
	const getOwnPropertySymbols = Object.getOwnPropertySymbols;
	if (getOwnPropertySymbols) {
		for (const symbol of getOwnPropertySymbols(src)) {
			if (Object.prototype.propertyIsEnumerable.call(src, symbol)) {
				setProperty(target, symbol, src[symbol]);
			}
		}
	}
	return target;
};
const definePropertiesFromSource = (target, source) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(
	source));
const definePublicProperty = (obj, key, value) => setProperty(obj, typeof key !== "symbol" ? key + "" : key, value);
const Direction = {
	up: "up",
	down: "down",
	left: "left",
	right: "right"
};
const ControlType = {
	onOff: "onOff",
	variable: "variable"
};
const EmulationMode = {
	real: "real",
	emulated: "emulated",
	overlay: "overlay"
};
const normalizeVector = (x, y, maxDistance) => {
	const distance = Math.sqrt(x * x + y * y);
	if (distance > maxDistance) {
		return {
			x: x / distance,
			y: y / distance
		};
	} else {
		return {
			x: x / maxDistance,
			y: y / maxDistance
		};
	}
}
const DEFAULT_BUTTON_COUNT = 18;
const DEFAULT_AXIS_COUNT = 4;
class GamepadEmulator {
	constructor(buttonPressThreshold) {
		definePublicProperty(this, "getNativeGamepads");
		definePublicProperty(this, "buttonPressThreshold", 0.1);
		definePublicProperty(this, "realGpadToPatchedIndexMap", []);
		definePublicProperty(this, "patchedGpadToRealIndexMap", []);
		definePublicProperty(this, "emulatedGamepads", []);
		definePublicProperty(this, "emulatedGamepadsMetadata", []);
		definePublicProperty(this, "undoEventPatch", () => {});
		definePublicProperty(this, "AddDisplayButtonEventListeners", this.AddButtonTouchEventListeners);
		definePublicProperty(this, "AddDisplayJoystickEventListeners", this.AddJoystickTouchEventListeners);
		definePublicProperty(this, "ClearDisplayButtonEventListeners", this.ClearButtonTouchEventListeners);
		definePublicProperty(this, "ClearDisplayJoystickEventListeners", this.ClearJoystickTouchEventListeners);
		this.buttonPressThreshold = buttonPressThreshold || this.buttonPressThreshold;
		if (GamepadEmulator.instanceRunning) {
			throw new Error("Only one GamepadEmulator instance may exist at a time!");
		}
		GamepadEmulator.instanceRunning = true;
		this.undoEventPatch = this.monkeyPatchGamepadEvents();
		this.monkeyPatchGetGamepads();
	}
	gamepadApiNativelySupported() {
		return !!this.getNativeGamepads && !!this.getNativeGamepads.apply(navigator);
	}
	AddEmulatedGamepad(index, overlayMode, buttonCount = DEFAULT_BUTTON_COUNT, axisCount = DEFAULT_AXIS_COUNT) {
		if ((index === -1 || (!index && index !== 0))) {
			index = this.nextEmptyEGpadIndex(overlayMode);
		}
		if (this.emulatedGamepads[index]) return false;
		const gamepad = {
			emulation: EmulationMode.emulated,
			connected: true,
			timestamp: performance.now(),
			displayId: "Emulated Gamepad " + index,
			id: "Emulated Gamepad " + index + " (Xinput STANDARD GAMEPAD)",
			mapping: "standard",
			index: index,
			buttons: new Array(buttonCount).fill({
				pressed: false,
				value: 0,
				touched: false
			}, 0, buttonCount),
			axes: new Array(axisCount).fill(0, 0, axisCount),
			hapticActuators: []
		};
		this.emulatedGamepads[index] = gamepad;
		this.emulatedGamepadsMetadata[index] = {
			overlayMode: overlayMode
		};
		const event = new Event("gamepadconnected");
		event.gamepad = gamepad;
		window.dispatchEvent(event);
		return gamepad;
	}
	RemoveEmulatedGamepad(index) {
		this.ClearButtonTouchEventListeners(index);
		this.ClearJoystickTouchEventListeners(index);
		const gamepad = this.emulatedGamepads[index];
		if (gamepad) {
			delete this.emulatedGamepads[index];
			delete this.emulatedGamepadsMetadata[index];
			const disconnectedGamepad = definePropertiesFromSource(mergeObjects({}, gamepad), {
				connected: false,
				timestamp: performance.now()
			});
			const event = new Event("gamepaddisconnected");
			event.gamepad = disconnectedGamepad;
			window.dispatchEvent(event);
		} else {
			console.warn(
				"GamepadEmulator Error: Cannot remove emulated gamepad. No emulated gamepad exists at index " +
				index);
		}
	}
	PressButton(gamepadIndex, buttonIndexOrIndices, value, touched) {
		if (this.emulatedGamepads[gamepadIndex] == null) {
			throw new Error("Error: PressButton() - no emulated gamepad at index " + gamepadIndex +
				", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index"
			);
		}
		const buttons = [...(this.emulatedGamepads[gamepadIndex]?.buttons || [])];
		const isPressed = value > this.buttonPressThreshold;
		const blen = this.emulatedGamepads[gamepadIndex].buttons.length;
		if (Array.isArray(buttonIndexOrIndices)) {
			const isTouched = isPressed || (touched ?? buttons[buttonIndexOrIndices[0]]?.touched) || false;
			const len = buttonIndexOrIndices.length;
			for (let i = 0; i < len; i++) {
				const idx = buttonIndexOrIndices[i];
				if (idx < 0 || idx >= blen) {
					console.error("Error: PressButton() - button index " + idx +
						" out of range, pass a valid index between 0 and " + (blen - 1));
					continue;
				}
				buttons[idx] = {
					pressed: isPressed,
					value: value || 0,
					touched: isTouched
				};
			}
		} else {
			const isTouched = isPressed || (touched ?? buttons[buttonIndexOrIndices]?.touched) || false;
			if (buttonIndexOrIndices < 0 || buttonIndexOrIndices >= blen) {
				console.error("Error: PressButton() - button index " + buttonIndexOrIndices +
					" out of range, pass a valid index between 0 and " + (blen - 1));
				return;
			}
			buttons[buttonIndexOrIndices] = {
				pressed: isPressed,
				value: value || 0,
				touched: isTouched
			};
		}
		defineProperty(this.emulatedGamepads[gamepadIndex], "buttons", {
			value: buttons,
			enumerable: true,
			configurable: true
		});
	}
	MoveAxis(gamepadIndex, axisIndex, value) {
		if (this.emulatedGamepads[gamepadIndex] == null) {
			throw new Error("Error: MoveAxis() - no emulated gamepad at index " + gamepadIndex +
				", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index"
			);
		}
		const axes = [...(this.emulatedGamepads[gamepadIndex]?.axes || [])];
		axes[axisIndex] = value;
		defineProperty(this.emulatedGamepads[gamepadIndex], "axes", {
			value: axes,
			enumerable: true,
			configurable: true
		});
	}
	AddButtonTouchEventListeners(gamepadIndex, buttonConfigs) {
		if (!this.emulatedGamepads[gamepadIndex]) {
			throw new Error("Error: AddButtonTouchEventListeners() - no emulated gamepad at index " +
				gamepadIndex +
				", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index"
			);
		}
		let cleanupFuncs = [];
		const len = buttonConfigs.length;
		for (let i = 0; i < len; i++) {
			const config = buttonConfigs[i];
			if (!config) continue;
			const buttonIndices = config.buttonIndexes ?? config.buttonIndex;
			const tapTarget = config.tapTarget;
			if (!tapTarget) {
				console.warn("GamepadEmulator: No tap target in gamepad " + gamepadIndex +
					" display config for button " + buttonIndices + ", skipping...");
				continue;
			}
			const onTouchStart = (e) => {
				const target = e.changedTouches[0].target;
				if (target === tapTarget || target.parentElement === tapTarget) e.preventDefault();
			};
			window.addEventListener("touchstart", onTouchStart, {
				passive: false
			});
			const onPointerEnter = (e) => {
				const isPressed = e.buttons === 1 ? 1 : 0;
				if (!config.lockTargetWhilePressed || isPressed === 0) this.PressButton(gamepadIndex,
					buttonIndices, isPressed, true);
			};
			tapTarget.addEventListener("pointerenter", onPointerEnter);
			const onPointerLeave = (e) => {
				const isPressed = e.buttons === 1 ? 1 : 0;
				if (!config.lockTargetWhilePressed || isPressed === 0) this.PressButton(gamepadIndex,
					buttonIndices, 0, false);
			};
			tapTarget.addEventListener("pointerleave", onPointerLeave);
			const onPointerCancel = () => {
				this.PressButton(gamepadIndex, buttonIndices, 0, false);
			};
			tapTarget.addEventListener("pointercancel", onPointerCancel);
			if (config.type === ControlType.onOff) {
				const onPointerDown = (e) => {
					e.preventDefault();
					this.PressButton(gamepadIndex, buttonIndices, 1, true);
					if (config.lockTargetWhilePressed) {
						tapTarget.setPointerCapture(e.pointerId);
					} else {
						tapTarget.releasePointerCapture(e.pointerId);
					}
				};
				tapTarget.addEventListener("pointerdown", onPointerDown);
				const onPointerUp = () => {
					this.PressButton(gamepadIndex, buttonIndices, 0);
				};
				tapTarget.addEventListener("pointerup", onPointerUp);
				cleanupFuncs.push(() => {
					window.removeEventListener("touchstart", onTouchStart);
					tapTarget.removeEventListener("pointerenter", onPointerEnter);
					tapTarget.removeEventListener("pointerleave", onPointerLeave);
					tapTarget.removeEventListener("pointerdown", onPointerDown);
					tapTarget.removeEventListener("pointerup", onPointerUp);
					tapTarget.removeEventListener("pointercancel", onPointerCancel);
				});
			} else if (config.type === ControlType.variable) {
				const removeDragListener = this.AddDragControlListener(config, (isDragging, x, y) => {
					let val = isDragging ? this.buttonPressThreshold + 0.00001 : 0;
					val += (config.directions[Direction.left] || config.directions[Direction.right]) ? Math
						.abs(x) : 0;
					val += (config.directions[Direction.up] || config.directions[Direction.down]) ? Math
						.abs(y) : 0;
					this.PressButton(gamepadIndex, buttonIndices, Math.min(val, 1));
				});
				cleanupFuncs.push(() => {
					window.removeEventListener("touchstart", onTouchStart);
					tapTarget.removeEventListener("pointerenter", onPointerEnter);
					tapTarget.removeEventListener("pointerleave", onPointerLeave);
					tapTarget.removeEventListener("pointercancel", onPointerCancel);
					removeDragListener();
				});
			}
		}
		this.emulatedGamepadsMetadata[gamepadIndex].removeButtonListenersFunc = () => {
			cleanupFuncs.forEach(fn => fn());
		};
	}
	AddJoystickTouchEventListeners(gamepadIndex, joystickConfigs) {
		if (!this.emulatedGamepads[gamepadIndex]) {
			throw new Error("Error: AddJoystickTouchEventListeners() - no emulated gamepad at index " +
				gamepadIndex +
				", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index"
			);
		}
		let cleanupFuncs = [];
		const len = joystickConfigs.length;
		for (let i = 0; i < len; i++) {
			const config = joystickConfigs[i];
			if (!config) continue;
			if (config.tapTarget == null) {
				console.warn("GamepadEmulator: No tap target in gamepad " + gamepadIndex +
					" display config for joystick " + i + ", skipping...");
				continue;
			}
			const removeDragListener = this.AddDragControlListener(config, (_isDragging, x, y) => {
				if (config.xAxisIndex !== undefined) this.MoveAxis(gamepadIndex, config.xAxisIndex, x);
				if (config.yAxisIndex !== undefined) this.MoveAxis(gamepadIndex, config.yAxisIndex, y);
			});
			cleanupFuncs.push(removeDragListener);
		}
		this.emulatedGamepadsMetadata[gamepadIndex].removeJoystickListenersFunc = () => {
			cleanupFuncs.forEach(fn => fn());
		};
	}
	ClearButtonTouchEventListeners(gamepadIndex) {
		const metadata = this.emulatedGamepadsMetadata[gamepadIndex];
		if (metadata && metadata.removeButtonListenersFunc) metadata.removeButtonListenersFunc();
	}
	ClearJoystickTouchEventListeners(gamepadIndex) {
		const metadata = this.emulatedGamepadsMetadata[gamepadIndex];
		if (metadata && metadata.removeJoystickListenersFunc) metadata.removeJoystickListenersFunc();
	}
	AddDragControlListener(config, callback) {
		let startPos = {
			startX: 0,
			startY: 0
		};
		let activePointerId = -1;
		let onPointerDown = null;
		const onPointerMove = (e) => {
			if (activePointerId === e.pointerId) {
				const minX = config.directions[Direction.left] ? -1 : 0;
				const maxX = config.directions[Direction.right] ? 1 : 0;
				const minY = config.directions[Direction.up] ? -1 : 0;
				const maxY = config.directions[Direction.down] ? 1 : 0;
				const deltaX = e.clientX - startPos.startX;
				const deltaY = e.clientY - startPos.startY;
				let {
					x,
					y
				} = normalizeVector(deltaX, deltaY, config.dragDistance);
				x = Math.max(Math.min(x, maxX), minX);
				y = Math.max(Math.min(y, maxY), minY);
				callback(true, x, y);
			}
		};
		const onPointerUp = (e) => {
			if (activePointerId === e.pointerId) {
				document.removeEventListener("pointermove", onPointerMove, false);
				document.removeEventListener("pointerup", onPointerUp, false);
				activePointerId = -1;
				callback(false, 0, 0);
			}
		};
		onPointerDown = (e) => {
			e.preventDefault();
			startPos.startX = e.clientX;
			startPos.startY = e.clientY;
			activePointerId = e.pointerId;
			if (config.lockTargetWhilePressed) {
				config.tapTarget.setPointerCapture(e.pointerId);
			} else {
				config.tapTarget.releasePointerCapture(e.pointerId);
			}
			callback(true, 0, 0);
			document.addEventListener("pointermove", onPointerMove, false);
			document.addEventListener("pointerup", onPointerUp, false);
		};
		config.tapTarget.addEventListener("pointerdown", onPointerDown);
		const onTouchStart = (e) => {
			if (e.changedTouches[0].target === config.tapTarget) e.preventDefault();
		};
		window.addEventListener("touchstart", onTouchStart, {
			passive: false
		});
		return function cleanup() {
			window.removeEventListener("touchstart", onTouchStart);
			config.tapTarget.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("pointermove", onPointerMove);
			document.removeEventListener("pointerup", onPointerUp);
		};
	}
	cloneGamepad(gamepad) {
		if (!gamepad) return gamepad;
		const axisCount = gamepad.axes ? gamepad.axes.length : 0;
		const buttonCount = gamepad.buttons ? gamepad.buttons.length : 0;
		const clone = {};
		for (let key in gamepad) {
			if (key === "axes") {
				const axes = new Array(axisCount);
				for (let i = 0; i < axisCount; i++) {
					axes[i] = Number(gamepad.axes[i]);
				}
				defineProperty(clone, "axes", {
					value: axes,
					enumerable: true,
					configurable: true
				});
			} else if (key === "buttons") {
				const buttons = new Array(buttonCount);
				for (let i = 0; i < buttonCount; i++) {
					const btn = gamepad.buttons[i];
					if (btn == null) {
						buttons[i] = btn;
					} else {
						buttons[i] = {
							pressed: btn.pressed,
							value: btn.value,
							touched: btn.touched || false
						};
					}
				}
				defineProperty(clone, "buttons", {
					value: buttons,
					enumerable: true,
					configurable: true
				});
			} else {
				defineProperty(clone, key, {
					get: () => gamepad[key],
					configurable: true,
					enumerable: true
				});
			}
		}
		if (!clone.emulation) {
			defineProperty(clone, "emulation", {
				value: EmulationMode.real,
				configurable: true,
				enumerable: true
			});
		}
		return clone;
	}
	nextEmptyEGpadIndex(overlayMode) {
		let index = 0;
		const len = this.emulatedGamepads.length;
		if (overlayMode) {
			do {
				if (!this.emulatedGamepads[index]) break;
				index++;
			} while (index < len);
		} else {
			const maxLen = Math.max(len, this.patchedGpadToRealIndexMap.length);
			do {
				if (!this.emulatedGamepads[index] && this.patchedGpadToRealIndexMap[index] == null) break;
				index++;
			} while (index < maxLen);
		}
		return index;
	}
	nextEmptyRealGpadIndex(startIndex) {
		let index = startIndex;
		const maxLen = Math.max(this.emulatedGamepads.length, this.patchedGpadToRealIndexMap.length);
		do {
			const metadata = this.emulatedGamepadsMetadata[index];
			const isFree = this.realGpadToPatchedIndexMap[index] == null && this.patchedGpadToRealIndexMap[index] ==
				null;
			if ((metadata && metadata.overlayMode) || (!metadata && isFree)) break;
			index++;
		} while (index < maxLen);
		return index;
	}
	monkeyPatchGamepadEvents() {
		let originalOnConnectDescriptor, originalOnDisconnectDescriptor;
		let onConnectHandler, onDisconnectHandler;
		if (window.hasOwnProperty("ongamepadconnected")) {
			originalOnConnectDescriptor = Object.getOwnPropertyDescriptor(window, "ongamepadconnected");
			originalOnConnectDescriptor.configurable = true;
			onConnectHandler = window.ongamepadconnected;
			window.ongamepadconnected = null;
			Object.defineProperty(window, "ongamepadconnected", {
				get: () => () => {},
				set: (handler) => {
					onConnectHandler = handler;
				},
				configurable: true
			});
		}
		if (window.hasOwnProperty("ongamepaddisconnected")) {
			originalOnDisconnectDescriptor = Object.getOwnPropertyDescriptor(window, "ongamepaddisconnected");
			originalOnDisconnectDescriptor.configurable = true;
			onDisconnectHandler = window.ongamepaddisconnected;
			window.ongamepaddisconnected = null;
			Object.defineProperty(window, "ongamepaddisconnected", {
				get: () => () => {},
				set: (handler) => {
					onDisconnectHandler = handler;
				},
				configurable: true
			});
		}
		const handleConnect = (event) => {
			const gamepad = event.gamepad;
			if (gamepad && gamepad.emulation === undefined) {
				event.stopImmediatePropagation();
				event.preventDefault();
				const cloned = this.cloneGamepad(event.gamepad);
				const realIndex = cloned.index;
				const patchedIndex = this.nextEmptyRealGpadIndex(realIndex);
				this.realGpadToPatchedIndexMap[realIndex] = patchedIndex;
				this.patchedGpadToRealIndexMap[patchedIndex] = realIndex;
				Object.defineProperty(cloned, "index", {
					get: () => patchedIndex
				});
				Object.defineProperty(cloned, "emulation", {
					get: () => EmulationMode.real
				});
				const newEvent = new Event(event.type || "gamepadconnected");
				newEvent.gamepad = cloned;
				window.dispatchEvent(newEvent);
			}
			if (onConnectHandler) onConnectHandler.call(window, event);
		};
		window.addEventListener("gamepadconnected", handleConnect);
		const handleDisconnect = (event) => {
			const gamepad = event.gamepad;
			if (gamepad && gamepad.emulation === undefined) {
				event.stopImmediatePropagation();
				event.preventDefault();
				const cloned = this.cloneGamepad(event.gamepad);
				const patchedIndex = this.realGpadToPatchedIndexMap[cloned.index] || cloned.index;
				Object.defineProperty(cloned, "index", {
					get: () => patchedIndex
				});
				Object.defineProperty(cloned, "emulation", {
					get: () => EmulationMode.real
				});
				delete this.realGpadToPatchedIndexMap[cloned.index];
				delete this.patchedGpadToRealIndexMap[patchedIndex];
				const newEvent = new Event(event.type || "gamepaddisconnected");
				newEvent.gamepad = cloned;
				window.dispatchEvent(newEvent);
			}
			if (onDisconnectHandler) onDisconnectHandler.call(window, event);
		};
		window.addEventListener("gamepaddisconnected", handleDisconnect);
		return function undo() {
			window.removeEventListener("gamepadconnected", handleConnect);
			if (window.hasOwnProperty("ongamepadconnected")) {
				Object.defineProperty(window, "ongamepadconnected", originalOnConnectDescriptor);
				window.ongamepadconnected = onConnectHandler;
			}
			window.removeEventListener("gamepaddisconnected", handleDisconnect);
			if (window.hasOwnProperty("ongamepaddisconnected")) {
				Object.defineProperty(window, "ongamepaddisconnected", originalOnDisconnectDescriptor);
				window.ongamepaddisconnected = onDisconnectHandler;
			}
		};
	}
	monkeyPatchGetGamepads() {
		const self = this;
		const originalGetGamepads = navigator.getGamepads ||
			navigator.webkitGetGamepads ||
			navigator.mozGetGamepads ||
			navigator.msGetGamepads;
		this.getNativeGamepads = originalGetGamepads;
		navigator.getNativeGamepads = originalGetGamepads || function() {
			return [];
		};
		Object.defineProperty(navigator, "getGamepads", {
			configurable: true,
			value: () => {
				const emulated = self.emulatedGamepads;
				const real = originalGetGamepads ? (originalGetGamepads.apply(navigator) || []) : [];
				const rlen = real.length;
				const elen = emulated.length;
				const result = new Array(Math.max(rlen, elen)).fill(null);
				for (let i = 0; i < rlen; i++) {
					const gamepad = real[i];
					if (!gamepad) continue;
					let cloned = self.cloneGamepad(gamepad);
					let patchedIndex = self.realGpadToPatchedIndexMap[cloned.index] || cloned.index;
					Object.defineProperty(cloned, "index", {
						get: () => patchedIndex
					});
					result[patchedIndex] = cloned;
				}
				for (let i = 0; i < elen; i++) {
					let existing = result[i];
					let emu = emulated[i];
					if (emu && existing) {
						Object.defineProperty(result[i], "emulation", {
							value: EmulationMode.overlay,
							configurable: true
						});
						let btnCount = Math.max(existing.buttons?.length || 0, emu.buttons.length);
						let buttons = new Array(btnCount);
						for (let j = 0; j < btnCount; j++) {
							const emuBtn = emu.buttons[j] || {
								touched: false,
								pressed: false,
								value: 0
							};
							const realBtn = existing.buttons[j] || {
								touched: false,
								pressed: false,
								value: 0
							};
							buttons[j] = {
								touched: emuBtn.touched || realBtn.touched || false,
								pressed: emuBtn.pressed || realBtn.pressed || false,
								value: Math.max(emuBtn.value, realBtn.value) || 0
							};
						}
						Object.defineProperty(result[i], "buttons", {
							value: buttons,
							enumerable: true,
							configurable: true
						});
						let axisCount = Math.max(emu.axes.length, existing.axes.length);
						let axes = new Array(axisCount);
						for (let j = 0; j < axisCount; j++) {
							const emuAxis = emu.axes[j] ?? 0;
							const realAxis = existing.axes[j] ?? 0;
							axes[j] = Math.abs(emuAxis) > Math.abs(realAxis) ? emuAxis : realAxis;
						}
						Object.defineProperty(result[i], "axes", {
							value: axes,
							enumerable: true,
							configurable: true
						});
					} else if (emu) {
						Object.defineProperty(emu, "emulation", {
							value: EmulationMode.emulated,
							enumerable: true,
							configurable: true
						});
						Object.defineProperty(emu, "timestamp", {
							value: performance.now(),
							enumerable: true,
							configurable: true
						});
						result[i] = self.cloneGamepad(emu);
					}
				}
				return result;
			}
		});
	}
	cleanup() {
		const len = this.emulatedGamepads.length;
		for (let i = 0; i < len; i++) {
			this.ClearButtonTouchEventListeners(i);
			this.ClearJoystickTouchEventListeners(i);
		}
		this.emulatedGamepads = [];
		this.undoEventPatch();
		if (this.getNativeGamepads) {
			Object.defineProperty(navigator, "getGamepads", {
				value: this.getNativeGamepads,
				configurable: true
			});
		} else {
			Object.defineProperty(navigator, "getGamepads", {
				value: undefined,
				configurable: true
			});
		}
		GamepadEmulator.instanceRunning = false;
		delete navigator.getNativeGamepads;
	}
}
definePublicProperty(GamepadEmulator, "instanceRunning", false);
/* gamepad模块结束 */
/* idbfs模块开始 */
const wrapIDBFS = (logger) => {
	const onLoadListeners = [];
	const onSaveListeners = [];
	const getDB = (instance, mount) => {
		return new Promise((resolve, reject) => {
			instance.getDB(mount.mountpoint, (err, db) => {
				if (err) return reject(err);
				resolve(db);
			});
		});
	}
	const saveToIDBFS = async (instance, mount, entries) => {
		const db = await getDB(instance, mount);
		return new Promise((resolve, reject) => {
			(async () => {
				const tx = db.transaction([instance.DB_STORE_NAME], "readwrite");
				const store = tx.objectStore(instance.DB_STORE_NAME);
				for (const entry of entries) {
					await new Promise((resolveStore, rejectStore) => {
						instance.storeRemoteEntry(store, entry.path, entry, (
							err) => {
							if (err) return rejectStore(err);
							resolveStore();
						});
					});
				}
				tx.onerror = (e) => {
					reject(e);
					e.preventDefault();
				};
				tx.oncomplete = () => {
					resolve();
				};
			})().catch(reject);
		});
	}
	const clearIDBFS = async (instance, mount) => {
		const db = await getDB(instance, mount);
		const store = db.transaction([instance.DB_STORE_NAME], "readwrite").objectStore(instance
			.DB_STORE_NAME);
		await new Promise((resolve, reject) => {
			const req = store.clear();
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}
	// 二进制编码/解码的辅助函数
	const writeInt32 = (buffer, value, offset) => {
		buffer[offset] = value & 255;
		buffer[offset + 1] = (value & 65280) >> 8;
		buffer[offset + 2] = (value & 16711680) >> 16;
		buffer[offset + 3] = (value & 4278190080) >> 24;
		return offset + 4;
	}
	const readInt32 = (buffer, offset) => {
		return (buffer[offset] & 255) | ((buffer[offset + 1] << 8) & 65280) | ((buffer[offset + 2] << 16) &
			16711680) | ((buffer[offset + 3] << 24) & 4278190080);
	}
	const writeInt64 = (buffer, value, offset) => {
		writeInt32(buffer, value >>> 0, offset);
		writeInt32(buffer, (value / 4294967296) >>> 0, offset + 4);
		return offset + 8;
	}
	const decodeEntries = (buffer) => {
		const entries = [];
		let offset = 0;
		const len = buffer.length;
		while (offset < len) {
			const pathLen = readInt32(buffer, offset);
			offset += 4;
			const path = textDecoder.decode(buffer.subarray(offset, offset + pathLen));
			offset += pathLen;
			const low = readInt32(buffer, offset);
			const high = readInt32(buffer, offset + 4);
			const timestamp = 4294967296 * high + low;
			offset += 8;
			const mode = readInt32(buffer, offset);
			offset += 4;
			const hasContents = buffer[offset] === 1;
			offset += 1;
			let contents;
			if (hasContents) {
				const contentLen = readInt32(buffer, offset);
				offset += 4;
				contents = buffer.subarray(offset, offset + contentLen);
				offset += contentLen;
			}
			entries.push({
				path: path,
				timestamp: new Date(timestamp),
				mode: mode,
				contents: contents
			});
		}
		return entries;
	}
	const encodeEntries = (entries) => {
		let size = 0;
		const processedEntries = entries.map(entry => {
			const encodedPath = new TextEncoder().encode(entry.path);
			size += 4 + encodedPath.length + 8 + 4 + 1 + (entry.contents ? 4 + entry.contents.length :
				0);
			return {
				key: encodedPath,
				time: entry.timestamp.getTime(),
				mode: entry.mode,
				contents: entry.contents
			};
		});
		const buffer = new Uint8Array(size);
		let offset = 0;
		for (const entry of processedEntries) {
			offset = writeInt32(buffer, entry.key.length, offset);
			buffer.set(entry.key, offset);
			offset += entry.key.length;
			offset = writeInt64(buffer, entry.time, offset);
			offset = writeInt32(buffer, entry.mode, offset);
			buffer[offset] = entry.contents ? 1 : 0;
			offset += 1;
			if (entry.contents) {
				offset = writeInt32(buffer, entry.contents.length, offset);
				buffer.set(entry.contents, offset);
				offset += entry.contents.length;
			}
		}
		return buffer;
	}
	const getLocalEntries = async (instance, mount) => {
		const localSet = await new Promise((resolve, reject) => {
			instance.getLocalSet(mount, (err, set) => {
				if (err) return reject(err);
				resolve(set);
			});
		});
		const entries = [];
		for (const path of Object.keys(localSet.entries)) {
			const entry = await new Promise((resolve, reject) => {
				instance.loadLocalEntry(path, (err, ent) => {
					if (err) return reject(err);
					resolve(ent);
				});
			});
			entry.path = path;
			entries.push(entry);
		}
		return entries;
	}
	window.syncfs = (instance, mount, populate, callback, originalSync) => {
		(async () => {
			if (populate) {
				for (const listener of onLoadListeners) {
					const data = await listener(instance, mount);
					if (data) {
						await clearIDBFS(instance, mount);
						if (data.length > 0) {
							const entries = decodeEntries(data);
							await saveToIDBFS(instance, mount, entries);
						}
						break;
					}
				}
			}
			originalSync((err) => {
				callback(err);
				(async () => {
					if (!populate) {
						let cachedData = null;
						const getData = async () => {
							if (cachedData === null) {
								const entries = await getLocalEntries(instance,
									mount);
								cachedData = encodeEntries(entries);
							}
							return cachedData;
						};
						for (const listener of onSaveListeners) {
							listener(getData, instance, mount);
						}
					}
				})().catch(err => {
					logger("ERR!!! syncfs error", err);
				});
			});
		})().catch(err => {
			logger("ERR!!! syncfs error", err);
			callback(err);
		});
	};
	return {
		addListener: (listener) => {
			onLoadListeners.push(listener.onLoad);
			onSaveListeners.push(listener.onSave);
		}
	};
}
/* idbfs模块结束 */
/* game核心模块开始 */
const clickToPlay = document.getElementById('click-to-play');
const statusElement = document.getElementById("status");
const progressElement = document.getElementById("progress");
const spinnerElement = document.getElementById('spinner');
let lang, data_content, wasm_content;
const clickToPlayButton = document.getElementById('click-to-play-button');
// 默认用户界面配置
let autoFullScreen = 1; //开启全屏
let cheatsEnabled = 1; //开启作弊
let maxFPS = 0; //最大帧率(0=无限制)
// 是否移动端
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let isTouch = isMobile && window.matchMedia('(pointer: coarse)').matches;
document.body.dataset.isTouch = isTouch ? 1 : 0;
const translations = {
	zh: {
		startGame: "开始游戏",
		openLocalArchive: "打开本地存档",
		invalidKey: "无效的密钥",
		checking: "正在检查...",
		cloudSaves: "云存档:",
		enabled: "已启用",
		disabled: "未启用",
		disclaimer: "免责声明：",
		disclaimerSources: "本游戏基于《侠盗猎车手：罪恶都市》开源版本制作，非商业发行，与R星游戏公司（Rockstar Games）无任何关联。",
		disclaimerPrompt: "你需要提供一份原版游戏文件，以确认你拥有该游戏的原版所有权。",
		demoAlert: "演示版仅用于熟悉游戏技术架构，所有功能均可使用，但无法推进游戏剧情主线。请提供原版游戏文件以启动完整版。",
		downloading: "数据下载中...",
		wasmloading: "环境下载中...",
		enterKey: "输入你的密钥",
		enterJsDosKey: "输入js-dos密钥（5位长度）",
		ruTranslate: "",
		configLanguage: "语言：",
		configCheats: "作弊（F3键）",
		configFullscreen: "全屏模式",
		configMaxFps: "帧率限制：",
		configUnlimited: "（0 = 无限制）",
		thanks: "特别感谢：",
		thanksText: "感谢以下项目给予的灵感，以及开发者们的付出，得以让本游戏在浏览器中实现！",
		// 表格翻译
		tableHeaderItem: "名称/说明",
		tableHeaderDesc: "作者/来源",
		primitive: "原开源版本",
		wasmporting: "WebAssembly移植",
		h5porting: "Web-H5移植",
		workerporting: "Worker移植"
	},
	en: {
		startGame: "Start Game",
		openLocalArchive: "Open Local Saves",
		invalidKey: "invalid key",
		checking: "checking...",
		cloudSaves: "Cloud saves:",
		enabled: "enabled",
		disabled: "disabled",
		disclaimer: "DISCLAIMER:",
		disclaimerSources: "This game is based on an open source version of GTA: Vice City. It is not a commercial release and is not affiliated with Rockstar Games.",
		disclaimerPrompt: "You need to provide a file from the original game to confirm ownership of the original game.",
		demoAlert: "The demo version is intended only for familiarizing yourself with the game technology. All features are available, but you won't be able to progress through the game's storyline. Please provide the original game files to launch the full version.",
		downloading: "Data downloading...",
		wasmloading: "Environment downloading...",
		enterKey: "enter your key",
		enterJsDosKey: "Enter js-dos key (5 len)",

		ruTranslate: "",
		configLanguage: "Language:",
		configCheats: "Cheats (F3)",
		configFullscreen: "Fullscreen",
		configMaxFps: "Max FPS:",
		configUnlimited: "(0 = unlimited)",
		thanks: "Special thanks:",
		thanksText: "Thanks to the following projects for the inspiration, and to the developers for their efforts, which made it possible for this game to be realized in the browser!",
		tableHeaderItem: "Name/Description",
		tableHeaderDesc: "Author/Source",
		primitive: "Original open-source version",
		wasmporting: "WebAssembly porting",
		h5porting: "Web-H5 Porting",
		workerporting: "Worker porting"
	},
	ru: {
		startGame: "Начать игру",
		openLocalArchive: "Открыть локальные сохранения",
		invalidKey: "неверный ключ",
		checking: "проверка...",
		cloudSaves: "Облачные сохранения:",
		enabled: "включены",
		disabled: "выключены",
		disclaimer: "ОТКАЗ ОТ ОТВЕТСТВЕННОСТИ:",
		disclaimerSources: "Эта игра основана на открытой версии GTA: Vice City. Она не является коммерческим изданием и не связана с Rockstar Games.",
		disclaimerPrompt: "Вам потребуется приложить какой-либо файл из оригинальной игры для подтверждения владения оригинальной игрой.",
		demoAlert: "Демо версия предназначена только для ознакомления с технологией игры. Все функции доступны, но вы не сможете продолжить игру по сюжету. Пожалуйста, предоставьте оригинальные файлы игры для запуска полной версии.",
		downloading: "Загрузка данных",
		wasmloading: "Загрузка среды...",
		enterKey: "введите ваш ключ",
		enterJsDosKey: "Введите ключ js-dos (5 букв)",
		ruTranslate: `
<div class="translated-by">
    <span>Переведено на русский студией</span>
    <a href="https://www.gamesvoice.ru/" target="_blank">GamesVoice</a>
</div>
`,
		configLanguage: "Язык:",
		configCheats: "Читы (F3)",
		configFullscreen: "Полный экран",
		configMaxFps: "Макс. FPS:",
		configUnlimited: "(0 = без ограничений)",
		thanks: "Особая благодарность:",
		thanksText: "Благодарим следующие проекты за вдохновение и усилия разработчиков, благодаря которым эта игра стала возможной в браузере!",
		tableHeaderItem: "Название/Описание",
		tableHeaderDesc: "Автор/Источник",
		primitive: "Оригинальная открытая версия",
		wasmporting: "Портирование WebAssembly",
		h5porting: "Перенос Web-H5",
		workerporting: "Перенос Worker"
	},
};
let currentLanguage = navigator.language.split("-")[0] === "zh" ? "zh" : "ru" ? "ru" : "en";
window.t = (key) => {
	return translations[currentLanguage][key] || key;
}
// 更新页面上所有翻译文本的功能
const updateAllTranslations = () => {
	if (clickToPlayButton) clickToPlayButton.textContent = t('startGame');
	const openLocalArchiveLink = document.getElementById('open-local-archive-link');
	if (openLocalArchiveLink) openLocalArchiveLink.textContent = t('openLocalArchive');
	const disclaimerText = document.getElementById('disclaimer-text');
	if (disclaimerText) disclaimerText.textContent = t('disclaimer');
	const disclaimerSources = document.getElementById('disclaimer-sources');
	if (disclaimerSources) disclaimerSources.textContent = t('disclaimerSources');
	// 如果存在，更新配置面板标签
	const configLangLabel = document.getElementById('config-lang-label');
	if (configLangLabel) configLangLabel.textContent = t('configLanguage');
	const configCheatsLabel = document.getElementById('config-cheats-label');
	if (configCheatsLabel) configCheatsLabel.textContent = t('configCheats');
	const configFullscreenLabel = document.getElementById('config-fullscreen-label');
	if (configFullscreenLabel) configFullscreenLabel.textContent = t('configFullscreen');
	const configMaxFpsLabel = document.getElementById('config-max-fps-label');
	if (configMaxFpsLabel) configMaxFpsLabel.textContent = t('configMaxFps');
	const configMaxFpsUnlimited = document.getElementById('config-max-fps-unlimited');
	if (configMaxFpsUnlimited) configMaxFpsUnlimited.textContent = t('configUnlimited');
	const thanks = document.getElementById('thanks');
	if (thanks) thanks.textContent = t('thanks');
	const thanksText = document.getElementById('thanksText');
	if (thanksText) thanksText.textContent = t('thanksText');
	// 表格翻译
	const tableHeaderItem = document.getElementById('table-header-item');
	if (tableHeaderItem) tableHeaderItem.textContent = t('tableHeaderItem');
	const tableHeaderDesc = document.getElementById('table-header-desc');
	if (tableHeaderDesc) tableHeaderDesc.textContent = t('tableHeaderDesc');
	const primitive = document.getElementById('primitive');
	if (primitive) primitive.textContent = t('primitive');
	const wasmporting = document.getElementById('wasmporting');
	if (wasmporting) wasmporting.textContent = t('wasmporting');
	const h5porting = document.getElementById('h5porting');
	if (h5porting) h5porting.textContent = t('h5porting');
	const workerporting = document.getElementById('workerporting');
	if (workerporting) workerporting.textContent = t('workerporting');
}
updateAllTranslations();
const setStatus = (text) => {
	if (!text) return;
	const match = text.match(/(.+)\((\d+\.?\d*)\/(\d+)\)/);
	if (match) {
		const [current, total] = match.slice(2, 4).map(Number);
		const percent = total > 0 ? (current / total * 100).toFixed(2) : '0.00';
		statusElement.textContent = t(match[1]) + `(${percent}%)`;
		progressElement.value = current;
		progressElement.max = total;
		progressElement.hidden = false;
		spinnerElement.hidden = false;
		spinnerElement.querySelector('.progress-bar-fill').style.width = percent + '%';
	} else {
		statusElement.textContent = text;
		progressElement.hidden = true;
		spinnerElement.hidden = true;
	}
}
// 根据语言更新游戏数据文件的功能
const updateGameDataForLanguage = (l) => {
	// lang = l === 'ru' ? 'ru' : 'en';
	lang = l === 'ru' ? 'en' : 'en';
	data_content = 'vc-sky-' + lang + '-v6.data.br';
	wasm_content = 'vc-sky-' + lang + '-v6.wasm.br';
};
updateGameDataForLanguage(currentLanguage);
// 开始游戏
clickToPlay.addEventListener('click', async (e) => {
	if (!isMobile && autoFullScreen) {
		document.body.requestFullscreen(document.documentElement);
		const lockMouseIfNeeded = () => {
			if (!document.pointerLockElement && typeof Module !== 'undefined' && Module.canvas) {
				Module.canvas.requestPointerLock({
					unadjustedMovement: true,
				}).catch(() => {
					console.warn('Failed to lock in unadjusted movement mode');
					Module.canvas.requestPointerLock().catch(() => {
						console.error('Failed to lock in default mode');
					});
				});
			}
		}
		document.addEventListener("mousedown", lockMouseIfNeeded, {
			capture: true
		});
		if (navigator.keyboard && navigator.keyboard.lock) {
			navigator.keyboard.lock(["Escape", "KeyW"]);
		}
	}
	e.stopPropagation();
	document.querySelector('.start-container').style.display = 'none';
	document.querySelector('.disclaimer').style.display = 'none';
	const intro = document.querySelector('.intro');
	const introContainer = document.querySelector('.intro-container');
	clickToPlay.style.display = 'none';
	document.querySelector('.loader-container').style.display = "flex";
	introContainer.hidden = false;
	intro.play();
	setStatus('准备中...');
	try {
		// 数据容器
		let workerFileData = {
			dataContent: null,
			wasmContent: null
		};
		const create7zWorker = async ({
			zName,
			title,
			path,
			targetFileName,
			storeKey,
			errorMsg,
			mountTo = null,
			mountKey = ''
		}) => {
			try {
				// 创建Worker实例
				const worker = new Worker('./script/worker.js');
				// 如果需要挂载到指定对象，就进行挂载
				if (mountTo && mountKey) {
					mountTo[mountKey] = worker;
				}
				await new Promise((resolve, reject) => {
					// 监听Worker消息
					worker.onmessage = (msg) => {
						const {
							type,
							data,
							error
						} = msg.data;
						switch (type) {
							case 'status':
								setStatus(data); // 同步状态
								break;
							case 'error':
								reject(new Error(error));
								break;
							case 'fileData':
								// 存储文件数据（根据传入的键名动态存储）
								if (data.name === targetFileName) {
									workerFileData[storeKey] = data.buffer;
								}
								break;
							case 'complete':
								// 读取所需文件
								worker.postMessage({
									type: 'readFile',
									fileName: targetFileName
								});
								// 检查文件数据是否就绪
								const checkDataReady = () => {
									if (workerFileData[storeKey]) {
										resolve();
									} else {
										setTimeout(checkDataReady, 100);
									}
								};
								checkDataReady();
								break;
						}
					};
					// 监听Worker错误
					worker.onerror = (err) => {
						reject(new Error(`Worker错误: ${err.message} (行${err.lineno})`));
					};
					// 监听Worker消息错误
					worker.onmessageerror = (err) => {
						reject(new Error(`Worker消息错误: ${err.message}`));
					};
					// 发送解压指令
					worker.postMessage({
						type: 'start',
						title: title,
						zName: zName,
						path: path
					});
				});
			} catch (err) {
				throw new Error(`${errorMsg}: ${err}`);
			}
		}
		// 全局7z Worker
		await create7zWorker({
			zName: 'rom-' + lang,
			title: 'downloading',
			path: 'https://storage.heheda.top/gtavc/rom-' + lang + '.7z',
			targetFileName: data_content,
			storeKey: 'dataContent',
			errorMsg: '创建全局Worker失败',
			mountTo: window,
			mountKey: 'global7zWorker'
		});
		// 私有7z Worker
		await create7zWorker({
			zName: 'data',
			title: 'wasmloading',
			path: '../data/data.7z',
			targetFileName: wasm_content,
			storeKey: 'wasmContent',
			errorMsg: '创建私有Worker失败'
		});
		// 校验文件数据
		if (!workerFileData.dataContent || !workerFileData.wasmContent) {
			throw new Error('必要数据获取不完整');
		}
		window.Module = {
			mainCalled: () => {
				try {
					const revc_ini = localStorage.getItem('vcsky.revc.ini') || `
					[VideoMode]
					Width=1024
					Height=768
					Depth=32
					Subsystem=0
					Windowed=0
					[Controller]
					HeadBob1stPerson=1
					HorizantalMouseSens=0.002500
					InvertMouseVertically=1
					DisableMouseSteering=1
					Vibration=1
					Method=${isTouch ? 1 : 0}
					InvertPad=0
					JoystickName=
					PadButtonsInited=0
					[Audio]
					SfxVolume=65
					MusicVolume=65
					MP3BoostVolume=0
					Radio=0
					SpeakerType=0
					Provider=0
					DynamicAcoustics=1
					[Display]
					Brightness=384
					DrawDistance=1.800000
					Subtitles=1
					ShowHud=1
					RadarMode=0
					ShowLegends=1
					PedDensity=100
					CarDensity=100
					CutsceneBorders=1
					FreeCam=1
					[Graphics]
					AspectRatio=0
					VSync=1
					Trails=1
					FrameLimiter=0
					MultiSampling=1
					IslandLoading=2
					PS2AlphaTest=1
					ColourFilter=1
					MotionBlur=1
					VehiclePipeline=1
					NeoRimLight=1
					NeoLightMaps=1
					NeoRoadGloss=1
					[General]
					SkinFile=$$""
					Language=0
					DrawVersionText=1
					NoMovies=0
					[CustomPipesValues]
					PostFXIntensity=1.000000
					NeoVehicleShininess=1.000000
					NeoVehicleSpecularity=1.000000
					RimlightMult=1.000000
					LightmapMult=1.000000
					GlossMult=1.000000
					[Rendering]
					BackfaceCulling=1
					NewRenderer=1
					[Draw]
					ProperScaling=1
					FixRadar=1
					FixSprites=1
					[Bindings]
					PED_FIREWEAPON=mouse:LEFT,2ndKbd:PAD5
					PED_CYCLE_WEAPON_RIGHT=2ndKbd:PADENTER,mouse:WHLDOWN,kbd:E
					PED_CYCLE_WEAPON_LEFT=kbd:PADDEL,mouse:WHLUP,2ndKbd:Q
					GO_FORWARD=kbd:UP,2ndKbd:W
					GO_BACK=kbd:DOWN,2ndKbd:S
					GO_LEFT=2ndKbd:A,kbd:LEFT
					GO_RIGHT=kbd:RIGHT,2ndKbd:D
					PED_SNIPER_ZOOM_IN=kbd:PGUP,2ndKbd:Z,mouse:WHLUP
					PED_SNIPER_ZOOM_OUT=kbd:PGDN,2ndKbd:X,mouse:WHLDOWN
					VEHICLE_ENTER_EXIT=kbd:ENTER,2ndKbd:F
					CAMERA_CHANGE_VIEW_ALL_SITUATIONS=kbd:HOME,2ndKbd:V
					PED_JUMPING=kbd:RCTRL,2ndKbd:SPC
					PED_SPRINT=2ndKbd:LSHIFT,kbd:RSHIFT
					PED_LOOKBEHIND=2ndKbd:CAPSLK,mouse:MIDDLE,kbd:PADINS
					PED_DUCK=kbd:C
					PED_ANSWER_PHONE=kbd:TAB
					VEHICLE_FIREWEAPON=kbd:PADINS,2ndKbd:LCTRL,mouse:LEFT
					VEHICLE_ACCELERATE=2ndKbd:W
					VEHICLE_BRAKE=2ndKbd:S
					VEHICLE_CHANGE_RADIO_STATION=kbd:INS,2ndKbd:R
					VEHICLE_HORN=2ndKbd:LSHIFT,kbd:RSHIFT
					TOGGLE_SUBMISSIONS=kbd:PLUS,2ndKbd:CAPSLK
					VEHICLE_HANDBRAKE=kbd:RCTRL,2ndKbd:SPC,mouse:RIGHT
					PED_1RST_PERSON_LOOK_LEFT=kbd:PADLEFT
					PED_1RST_PERSON_LOOK_RIGHT=kbd:PADHOME
					VEHICLE_LOOKLEFT=kbd:PADEND,2ndKbd:Q
					VEHICLE_LOOKRIGHT=kbd:PADDOWN,2ndKbd:E
					VEHICLE_LOOKBEHIND=mouse:MIDDLE
					VEHICLE_TURRETLEFT=kbd:PADLEFT
					VEHICLE_TURRETRIGHT=kbd:PAD5
					VEHICLE_TURRETUP=kbd:PADPGUP,2ndKbd:UP
					VEHICLE_TURRETDOWN=kbd:PADRIGHT,2ndKbd:DOWN
					PED_CYCLE_TARGET_LEFT=kbd:[,2ndKbd:PADEND
					PED_CYCLE_TARGET_RIGHT=2ndKbd:],kbd:PADDOWN
					PED_CENTER_CAMERA_BEHIND_PLAYER=kbd:#
					PED_LOCK_TARGET=kbd:DEL,mouse:RIGHT,2ndKbd:PADRIGHT
					NETWORK_TALK=kbd:T
					PED_1RST_PERSON_LOOK_UP=kbd:PADPGUP
					PED_1RST_PERSON_LOOK_DOWN=kbd:PADUP
					_CONTROLLERACTION_36=
					TOGGLE_DPAD=
					SWITCH_DEBUG_CAM_ON=
					TAKE_SCREEN_SHOT=
					SHOW_MOUSE_POINTER_TOGGLE=
					UNKNOWN_ACTION=
					`;
					if (Module.FS) {
						Module.FS.unlink("/vc-assets/local/revc.ini");
						Module.FS.createDataFile("/vc-assets/local/revc.ini", 0, revc_ini, revc_ini
							.length);
					}
				} catch (e) {
					console.error('mainCalled error:', e);
				}
			},
			syncRevcIni: () => {
				try {
					if (Module.FS) {
						const path = Module.FS.lookupPath("/vc-assets/local/revc.ini");
						if (path && path.node && path.node.contents) {
							localStorage.setItem('vcsky.revc.ini', textDecoder.decode(path.node
								.contents));
						}
					}
				} catch (e) {
					console.error('syncRevcIni error:', e);
				}
			},
			print: (args) => {
				if (args.trim().length > 0) console.log(args);
			},
			printErr: (args) => {
				if (args.trim().length > 0) console.error(args);
			},
			getPreloadedPackage: () => {
				return workerFileData.dataContent;
			},
			canvas: (() => {
				const canvas = document.getElementById('canvas');
				canvas.addEventListener('webglcontextlost', (e) => {
					statusElement.textContent =
						'WebGL context lost. Please reload the page.';
					e.preventDefault();
				});
				return canvas;
			})(),
			setStatus,
			totalDependencies: 0,
			monitorRunDependencies: (num) => {
				Module.totalDependencies = Math.max(Module.totalDependencies, num);
				Module.setStatus(
					`Preparing... (${Module.totalDependencies - num}/${Module.totalDependencies})`
				);
			},
			// 自定义中止
			hotelMission: () => {},
			instantiateWasm: async (info, receiveInstance) => {
				const module = await WebAssembly.instantiate(workerFileData.wasmContent,
					info);
				return receiveInstance(module.instance, module);
			},
			arguments: window.location.search.slice(1).split('&').filter(Boolean).map(
				decodeURIComponent),
			noExitRuntime: true
		};
		window.onerror = (message) => {
			Module.setStatus(`Error: ${message}`);
			spinnerElement.hidden = true;
		};
		window.onbeforeunload = (event) => {
			event.preventDefault();
			return '';
		};
		// 加载核心JS
		const modules = [
			'./modules/runtime.js',
			// (currentLanguage === 'ru' ? './modules/packages/ru.js' : './modules/packages/en.js'),
			'./modules/packages/en.js',
			'./modules/loader.js',
			'./modules/fs.js',
			'./modules/audio.js',
			'./modules/graphics.js',
			'./modules/events.js',
			'./modules/fetch.js',
			// (currentLanguage === 'ru' ? './modules/asm_consts/ru.js' : './modules/asm_consts/en.js'),
			'./modules/asm_consts/en.js',
			'./modules/main.js'
		];
		if (cheatsEnabled) modules.push('./modules/cheats.js');
		const jslen = modules.length;
		for (let i = 0; i < jslen; i++) {
			try {
				await new Promise((resolve, reject) => {
					const s = document.createElement('script');
					s.defer = true;
					s.src = modules[i];
					s.onload = resolve;
					s.onerror = () => reject(new Error(`Failed to load module: ${modules[i]}`));
					document.body.appendChild(s);
				});
			} catch (err) {
				console.error(err.message);
				break;
			}
		}
		document.body.classList.add('gameIsStarted');
		const emulator = new GamepadEmulator();
		emulator.AddEmulatedGamepad(null, true);
		emulator.AddDisplayJoystickEventListeners(0, [{
			directions: {
				up: true,
				down: true,
				left: true,
				right: true
			},
			dragDistance: 100,
			tapTarget: document.getElementById('move'),
			lockTargetWhilePressed: true,
			xAxisIndex: 0,
			yAxisIndex: 1,
			swapAxes: false,
			invertX: false,
			invertY: false,
		}]);
		emulator.AddDisplayJoystickEventListeners(0, [{
			directions: {
				up: true,
				down: true,
				left: true,
				right: true
			},
			dragDistance: 100,
			tapTarget: document.getElementById('look'),
			lockTargetWhilePressed: true,
			xAxisIndex: 2,
			yAxisIndex: 3,
			swapAxes: false,
			invertX: false,
			invertY: false,
		}]);
		emulator.AddDisplayButtonEventListeners(0, [{
				buttonIndex: 9,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.menu')
			},
			{
				buttonIndex: 3,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.car.getIn')
			},
			{
				buttonIndex: 0,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.run')
			},
			{
				buttonIndex: 1,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.fist')
			},
			{
				buttonIndex: 5,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.drift')
			},
			{
				buttonIndex: 2,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.jump')
			},
			{
				buttonIndex: 11,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.job')
			},
			{
				buttonIndex: 4,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.radio')
			},
			{
				buttonIndex: 7,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.weapon')
			},
			{
				buttonIndex: 8,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.camera')
			},
			{
				buttonIndex: 10,
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.horn')
			},
			{
				buttonIndex: 7,
				buttonIndexes: [1, 7],
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.fireRight')
			},
			{
				buttonIndex: 6,
				buttonIndexes: [1, 6],
				lockTargetWhilePressed: false,
				tapTarget: document.querySelector('.touch-control.fireLeft')
			}
		]);
		spinnerElement.hidden = true;
		introContainer.style.cursor = 'pointer';
		intro.pause();
		introContainer.style.display = 'none';

	} catch (err) {
		setStatus(err.message);
		console.error('初始化失败:', err);
		throw err;
	}
});
// 调用 wrapIDBFS 并添加监听器
const savesMountPoint = "/vc-assets/local/userfiles";
const savesFile = "vcsky.saves";
wrapIDBFS(console.log).addListener({
	onLoad: (_, mount) => {
		if (mount.mountpoint !== savesMountPoint) return null;
		const token = localStorage.getItem('vcsky.key');
		if (token && token.length === 5) {
			const promise = CloudSDK.pullFromStorage(token, savesFile);
			promise.then((payload) => {
				console.log('[IDBFS] onLoad', token, payload ? payload.length / 1024 : 0, 'kb');
			});
			return promise;
		}
		return null;
	},
	onSave: (getData, _, mount) => {
		if (mount.mountpoint !== savesMountPoint) return;
		const token = localStorage.getItem('vcsky.key');
		if (token && token.length === 5) {
			getData().then((payload) => {
				if (payload.length > 0) {
					console.log('[IDBFS] onSave', token, payload.length / 1024, 'kb');
					return CloudSDK.pushToStorage(token, savesFile, payload);
				}
			});
		}
	},
});
// 配置模式界面
const configLang = document.getElementById('config-lang');
const configCheats = document.getElementById('config-cheats');
const configFullscreen = document.getElementById('config-fullscreen');
const configMaxFps = document.getElementById('config-max-fps');
// 从 URL 参数设置初始值
configCheats.checked = cheatsEnabled;
configFullscreen.checked = autoFullScreen;
configLang.value = currentLanguage;
// 语言选择处理程序
configLang.addEventListener('change', (e) => {
	currentLanguage = e.target.value;
	updateGameDataForLanguage(currentLanguage);
	updateAllTranslations();
});
// 更改时更新设置
configCheats.addEventListener('change', (e) => {
	cheatsEnabled = e.target.checked;
});
configFullscreen.addEventListener('change', (e) => {
	autoFullScreen = e.target.checked;
});
configMaxFps.addEventListener('input', (e) => {
	maxFPS = parseInt(e.target.value) || 0;
});
/* game核心模块结束 */