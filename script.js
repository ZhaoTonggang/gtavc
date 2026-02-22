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
				if (target === tapTarget || target.parentElement === tapTarget) {
					e.preventDefault();
				}
			};
			window.addEventListener("touchstart", onTouchStart, {
				passive: false
			});
			const onPointerEnter = (e) => {
				const isPressed = e.buttons === 1 ? 1 : 0;
				if (!config.lockTargetWhilePressed || isPressed === 0) {
					this.PressButton(gamepadIndex, buttonIndices, isPressed, true);
				}
			};
			tapTarget.addEventListener("pointerenter", onPointerEnter);
			const onPointerLeave = (e) => {
				const isPressed = e.buttons === 1 ? 1 : 0;
				if (!config.lockTargetWhilePressed || isPressed === 0) {
					this.PressButton(gamepadIndex, buttonIndices, 0, false);
				}
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
				if (config.xAxisIndex !== undefined) {
					this.MoveAxis(gamepadIndex, config.xAxisIndex, x);
				}
				if (config.yAxisIndex !== undefined) {
					this.MoveAxis(gamepadIndex, config.yAxisIndex, y);
				}
			});
			cleanupFuncs.push(removeDragListener);
		}
		this.emulatedGamepadsMetadata[gamepadIndex].removeJoystickListenersFunc = () => {
			cleanupFuncs.forEach(fn => fn());
		};
	}
	ClearButtonTouchEventListeners(gamepadIndex) {
		const metadata = this.emulatedGamepadsMetadata[gamepadIndex];
		if (metadata && metadata.removeButtonListenersFunc) {
			metadata.removeButtonListenersFunc();
		}
	}
	ClearJoystickTouchEventListeners(gamepadIndex) {
		const metadata = this.emulatedGamepadsMetadata[gamepadIndex];
		if (metadata && metadata.removeJoystickListenersFunc) {
			metadata.removeJoystickListenersFunc();
		}
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
			if (e.changedTouches[0].target === config.tapTarget) {
				e.preventDefault();
			}
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
		return (buffer[offset] & 255) |
			((buffer[offset + 1] << 8) & 65280) |
			((buffer[offset + 2] << 16) & 16711680) |
			((buffer[offset + 3] << 24) & 4278190080);
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
if (typeof exports === 'object' && typeof module !== 'undefined') {
	module.exports.wrapIDBFS = wrapIDBFS;
}
window.wrapIDBFS = wrapIDBFS;
/* idbfs模块结束 */
/* game核心模块开始 */
const clickToPlay = document.getElementById('click-to-play');
const statusElement = document.getElementById("status");
const progressElement = document.getElementById("progress");
const spinnerElement = document.getElementById('spinner');
let lang, data_content, wasm_content, wasm_data;
const params = new URLSearchParams(window.location.search);
const clickToPlayButton = document.getElementById('click-to-play-button');
const demoOffDisclaimer = document.getElementById('demo-off-disclaimer');
// 可配置模式 - 播放前显示设置界面
//const configurableMode = params.get('configurable') === "1";
const configurableMode = "1";
// 可以通过 URL 或用户界面配置的设置
let autoFullScreen = params.get('fullscreen') !== "0";
let cheatsEnabled = params.get('cheats') === "1" || configurableMode;
let maxFPS = parseInt(params.get('max_fps')) || 0;
// 完整游戏访问
if (params.get('request_original_game') !== "1") localStorage.setItem('vcsky.haveOriginalGame', 'true');
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let isTouch = isMobile && window.matchMedia('(pointer: coarse)').matches;
document.body.dataset.isTouch = isTouch ? 1 : 0;
let haveOriginalGame = false;
const translations = {
	zh: {
		clickToPlayDemo: "点击开始",
		clickToPlayFull: "开始游戏",
		openLocalArchive: "打开本地存档",
		invalidKey: "无效的密钥",
		checking: "正在检查...",
		cloudSaves: "云存档:",
		enabled: "已启用",
		disabled: "未启用",
		playDemoText: "您也可以提供原始游戏文件以体验完整版。",
		disclaimer: "免责声明：",
		disclaimerSources: "本游戏基于《侠盗猎车手：罪恶都市》开源版本制作，非商业发行，与R星游戏公司（Rockstar Games）无任何关联。",
		disclaimerCheckbox: "我拥有该游戏原版",
		disclaimerPrompt: "你需要提供一份原版游戏文件，以确认你拥有该游戏的原版所有权。",
		cantContinuePlaying: "演示版无法继续游玩剧情。请提供原版游戏文件以继续体验。",
		demoAlert: "演示版仅用于熟悉游戏技术架构，所有功能均可使用，但无法推进游戏剧情主线。请提供原版游戏文件以启动完整版。",
		downloading: "数据下载中...",
		enterKey: "输入你的密钥",
		enterJsDosKey: "输入js-dos密钥（5位长度）",
		ruTranslate: "",
		demoOffDisclaimer: "因该项目人气超出预期，产生了高额流量成本；同时为避免因版权方投诉导致项目被下架的风险，我们已关闭演示版功能。你仍可通过提供原版游戏资源来运行完整版。",
		configLanguage: "语言：",
		configCheats: "作弊（F3键）",
		configFullscreen: "全屏模式",
		configMaxFps: "最大帧率：",
		configUnlimited: "（0 = 无限制）",
		// 新增表格表头翻译
		tableHeaderItem: "配置项名称",
		tableHeaderRange: "取值范围",
		tableHeaderDesc: "说明",
		// 新增表格配置项说明翻译
		configLangDesc: "游戏语言",
		configCheatsDesc: "启用作弊菜单（按F3键呼出）",
		configOriginalGameDesc: "游玩前请求下载原始游戏文件",
		configFullscreenDesc: "禁用自动全屏功能",
		configMaxFpsDesc: "限制游戏帧率（例如：设置60代表60帧/秒）",
		configConfigurableDesc: "在「开始游戏」按钮前显示配置界面",
	},
	en: {
		clickToPlayDemo: "Click to play",
		clickToPlayFull: "Start Game",
		openLocalArchive: "Open Local Saves",
		invalidKey: "invalid key",
		checking: "checking...",
		cloudSaves: "Cloud saves:",
		enabled: "enabled",
		disabled: "disabled",
		playDemoText: "You can also provide the original game files to experience the full version.",
		disclaimer: "DISCLAIMER:",
		disclaimerSources: "This game is based on an open source version of GTA: Vice City. It is not a commercial release and is not affiliated with Rockstar Games.",
		disclaimerCheckbox: "I own the original game",
		disclaimerPrompt: "You need to provide a file from the original game to confirm ownership of the original game.",
		cantContinuePlaying: "You can't continue playing in DEMO version. Please provide the original game files to continue playing.",
		demoAlert: "The demo version is intended only for familiarizing yourself with the game technology. All features are available, but you won't be able to progress through the game's storyline. Please provide the original game files to launch the full version.",
		downloading: "Downloading...",
		enterKey: "enter your key",
		enterJsDosKey: "Enter js-dos key (5 len)",

		ruTranslate: "",
		demoOffDisclaimer: "Due to the unexpectedly high popularity of the project, resulting in significant traffic costs, and in order to avoid any risk of the project being shut down due to rights holder claims, we have disabled the demo version. You can still run the full version by providing the original game resources.",
		configLanguage: "Language:",
		configCheats: "Cheats (F3)",
		configFullscreen: "Fullscreen",
		configMaxFps: "Max FPS:",
		configUnlimited: "(0 = unlimited)",
		// 新增表格表头翻译
		tableHeaderItem: "Configuration Item Name",
		tableHeaderRange: "Value Range",
		tableHeaderDesc: "Description",
		// 新增表格配置项说明翻译
		configLangDesc: "Game Language",
		configCheatsDesc: "Enable Cheat Menu (Press F3 to open)",
		configOriginalGameDesc: "Request to download original game files before playing",
		configFullscreenDesc: "Disable automatic fullscreen function",
		configMaxFpsDesc: "Limit game frame rate (e.g., set 60 for 60 FPS)",
		configConfigurableDesc: "Show configuration interface before the \"Start Game\" button",
	},
	ru: {
		clickToPlayDemo: "Нажмите, чтобы начать",
		clickToPlayFull: "Начать игру",
		openLocalArchive: "Открыть локальные сохранения",
		invalidKey: "неверный ключ",
		checking: "проверка...",
		cloudSaves: "Облачные сохранения:",
		enabled: "включены",
		disabled: "выключены",
		playDemoText: "Вы также можете предоставить исходные игровые файлы, чтобы попробовать полную версию.",
		disclaimer: "ОТКАЗ ОТ ОТВЕТСТВЕННОСТИ:",
		disclaimerSources: "Эта игра основана на открытой версии GTA: Vice City. Она не является коммерческим изданием и не связана с Rockstar Games.",
		disclaimerCheckbox: "Я владею оригинальной игрой",
		disclaimerPrompt: "Вам потребуется приложить какой-либо файл из оригинальной игры для подтверждения владения оригинальной игрой.",
		cantContinuePlaying: "Вы не можете продолжить игру в демо версии. Пожалуйста, предоставьте оригинальные файлы игры для продолжения игры.",
		demoAlert: "Демо версия предназначена только для ознакомления с технологией игры. Все функции доступны, но вы не сможете продолжить игру по сюжету. Пожалуйста, предоставьте оригинальные файлы игры для запуска полной версии.",
		downloading: "Загрузка...",
		enterKey: "введите ваш ключ",
		enterJsDosKey: "Введите ключ js-dos (5 букв)",
		ruTranslate: `
<div class="translated-by">
    <span>Переведено на русский студией</span>
    <a href="https://www.gamesvoice.ru/" target="_blank">GamesVoice</a>
</div>
`,
		demoOffDisclaimer: "В связи с неожиданно высокой популярностью проекта, как следствие — значительными расходами на трафик, а также во избежание рисков закрытия проекта из-за претензий правообладателей, мы отключили возможность запуска демо-версии. При этом вы по-прежнему можете запустить полную версию, предоставив оригинальные ресурсы.",
		configLanguage: "Язык:",
		configCheats: "Читы (F3)",
		configFullscreen: "Полный экран",
		configMaxFps: "Макс. FPS:",
		configUnlimited: "(0 = без ограничений)",
		// 新增表格表头翻译
		tableHeaderItem: "Название параметра конфигурации",
		tableHeaderRange: "Диапазон значений",
		tableHeaderDesc: "Описание",
		// 新增表格配置项说明翻译
		configLangDesc: "Язык игры",
		configCheatsDesc: "Включить меню читов (нажмите F3 для открытия)",
		configOriginalGameDesc: "Запросить загрузку оригинальных игровых файлов перед запуском",
		configFullscreenDesc: "Отключить автоматическую функцию полноэкранного режима",
		configMaxFpsDesc: "Ограничить частоту кадров игры (например: установите 60 для 60 FPS)",
		configConfigurableDesc: "Показать интерфейс конфигурации перед кнопкой «Запустить игру»",
	},
};
let currentLanguage = navigator.language.split("-")[0] === "zh" ? "zh" : "ru" ? "ru" : "en";
const glang = params.get("lang");
if (glang === "zh") currentLanguage = "zh";
if (glang === "ru") currentLanguage = "ru";
if (glang === "en") currentLanguage = "en";
window.t = (key) => {
	return translations[currentLanguage][key];
}
// 更新页面上所有翻译文本的功能
const updateAllTranslations = () => {
	if (clickToPlayButton) clickToPlayButton.textContent = haveOriginalGame ? t('clickToPlayFull') : t(
		'clickToPlayDemo');
	const openLocalArchiveLink = document.getElementById('open-local-archive-link');
	if (openLocalArchiveLink) openLocalArchiveLink.textContent = t('openLocalArchive');
	if (demoOffDisclaimer) demoOffDisclaimer.textContent = haveOriginalGame ? "" : "* " + t('demoOffDisclaimer');
	const playDemoText = document.getElementById('play-demo-text');
	if (playDemoText) playDemoText.textContent = t('playDemoText');
	const disclaimerText = document.getElementById('disclaimer-text');
	if (disclaimerText) disclaimerText.textContent = t('disclaimer');
	const disclaimerSources = document.getElementById('disclaimer-sources');
	if (disclaimerSources) disclaimerSources.textContent = t('disclaimerSources');
	const disclaimerCheckboxLabel = document.getElementById('disclaimer-checkbox-label');
	if (disclaimerCheckboxLabel) disclaimerCheckboxLabel.textContent = t('disclaimerCheckbox');
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
	// 配置表格翻译逻辑
	const tableHeaderItem = document.getElementById('table-header-item');
	if (tableHeaderItem) tableHeaderItem.textContent = t('tableHeaderItem');
	const tableHeaderRange = document.getElementById('table-header-range');
	if (tableHeaderRange) tableHeaderRange.textContent = t('tableHeaderRange');
	const tableHeaderDesc = document.getElementById('table-header-desc');
	if (tableHeaderDesc) tableHeaderDesc.textContent = t('tableHeaderDesc');
	const configDescLang = document.getElementById('config-desc-lang');
	if (configDescLang) configDescLang.textContent = t('configLangDesc');
	const configDescCheats = document.getElementById('config-desc-cheats');
	if (configDescCheats) configDescCheats.textContent = t('configCheatsDesc');
	const configDescOriginalGame = document.getElementById('config-desc-original-game');
	if (configDescOriginalGame) configDescOriginalGame.textContent = t('configOriginalGameDesc');
	const configDescFullscreen = document.getElementById('config-desc-fullscreen');
	if (configDescFullscreen) configDescFullscreen.textContent = t('configFullscreenDesc');
	const configDescMaxFps = document.getElementById('config-desc-max-fps');
	if (configDescMaxFps) configDescMaxFps.textContent = t('configMaxFpsDesc');
	const configDescConfigurable = document.getElementById('config-desc-configurable');
	if (configDescConfigurable) configDescConfigurable.textContent = t('configConfigurableDesc');
}
const setStatus = (text) => {
	if (!text) return;
	const match = text.match(/(.+)\((\d+\.?\d*)\/(\d+)\)/);
	if (match) {
		const [current, total] = match.slice(2, 4).map(Number);
		const percent = total > 0 ? (current / total * 100).toFixed(2) : '0.00';
		statusElement.textContent = t("downloading") + `(${percent}%)`;
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
const zipdata = async () => {
	setStatus('正在初始化...');
	// 定义文件名
	const zName = 'rom-' + lang;
	let js7z;
	// 工具函数：将同步操作拆分为异步切片执行
	const runInSlices = async (task, sliceTime = 50) => {
		// 封装迭代器，让任务可以分段执行
		const taskIterator = task();
		const executeSlice = async () => {
			let startTime = performance.now();
			let result;
			// 执行直到超时或任务完成
			do {
				result = taskIterator.next();
				if (result.done) break;
				// 每执行一小段就检查是否超时
			} while (performance.now() - startTime < sliceTime);
			if (!result.done) {
				// 兼容requestIdleCallback，降级为setTimeout
				await new Promise(resolve => {
					if (window.requestIdleCallback) {
						requestIdleCallback(resolve, {
							timeout: 100
						});
					} else {
						setTimeout(resolve, 10); // 降级方案
					}
				});
				return executeSlice();
			}
			return result.value;
		};
		return executeSlice();
	};
	try {
		// 初始化JS7z实例
		js7z = window.js7z = await new Promise((resolve) => {
			// 使用setTimeout让出主线程
			setTimeout(async () => {
				const instance = await JS7z({
					print: (str) => {
						if (str.trim().length === 0) return;
						console.log(str);
					},
					printErr: (str) => {
						if (str.trim().length === 0) return;
						console.error(str);
					},
					noExitRuntime: true
				});
				resolve(instance);
			}, 0);
		});
		if (!js7z) throw new Error('初始化失败！');
		// 优先从缓存读取
		let cache = await caches.open('GameData');
		let buffer = await cache.match(zName);
		// 如果缓存存在且有效，直接使用缓存数据
		if (buffer) {
			setStatus("正在从缓存加载数据包");
			buffer = new Uint8Array(await buffer.arrayBuffer());
		} else {
			// 缓存不存在时下载文件
			setStatus('开始下载数据包');
			const response = await fetch('https://storage.heheda.top/gtavc/' + zName + '.7z');
			// 检查响应状态
			if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
			// Content-Length返回字符串转数字
			const datalen = Number(response.headers.get('Content-Length'));
			const zdata = response.body.getReader();
			let chunks = [];
			let receivedLength = 0;
			// 流式下载文件
			while (true) {
				const {
					done,
					value
				} = await zdata.read();
				if (done) break;
				chunks.push(value);
				receivedLength += value.length;
				setStatus(`Downloading...(${receivedLength}/${datalen})`);
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			// 拼接二进制数据
			buffer = new Uint8Array(receivedLength);
			await runInSlices(function*() {
				let position = 0;
				for (let chunk of chunks) {
					buffer.set(chunk, position);
					position += chunk.length;
					// 每处理一个chunk就yield，让主线程有机会响应
					yield;
				}
			});
			// 下载完成后立即写入缓存
			console.log('将下载的压缩包写入缓存');
			await new Promise(resolve => setTimeout(async () => {
				setStatus("正在写入缓存");
				await cache.put(zName, new Response(buffer, {
					headers: {
						'Content-Type': 'application/x-7z-compressed'
					}
				}));
				resolve();
			}, 0));
		}
		if (!buffer) throw new Error('压缩包数据为空');
		setStatus("正在解压数据...");
		// 分块写入7z内存文件系统
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
					// 更新写入进度
					setStatus(`正在写入数据...(${position}/${blen})`);
					yield; // 让出主线程
				}
			} finally {
				if (stream) {
					js7z.FS.close(stream); // 确保文件句柄关闭
				}
			}
		});
		// 解压所有文件
		await new Promise((resolve, reject) => {
			try {
				// 执行解压命令
				js7z.callMain(['x', zName, '-p2585649532', '-aoa', '-y']);
				// 等待解压完成
				wasm_data = js7z.FS.readFile(wasm_content);
				resolve();
			} catch (e) {
				reject(e);
			}
		});
		setStatus("数据解压完成");
		// 读取解压后指定文件
		return js7z.FS.readFile(data_content);
	} catch (err) {
		setStatus(err.message);
		throw (err);
	} finally {
		// 清理内存文件系统（避免内存泄漏）
		if (js7z.FS.analyzePath(zName).exists) {
			setTimeout(() => {
				try {
					js7z.FS.unlink(zName);
				} catch (e) {
					console.error('清理7z文件失败：', e);
				}
			}, 0);
		}
	}
}
const revc_ini = (() => {
	const cached = localStorage.getItem('vcsky.revc.ini');
	if (cached) {
		return cached;
	}
	return `
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
})();
const startGame = async (e) => {
	e.stopPropagation();
	document.querySelector('.start-container').style.display = 'none';
	document.querySelector('.disclaimer').style.display = 'none';
	const intro = document.querySelector('.intro');
	const introContainer = document.querySelector('.intro-container');
	const loaderContainer = document.querySelector('.loader-container');
	clickToPlay.style.display = 'none';
	loaderContainer.style.display = "flex";
	introContainer.hidden = false;
	intro.play();
	const dataBuffer = await zipdata();
	const Module = window.Module = {
		mainCalled: () => {
			try {
				Module.FS.unlink("/vc-assets/local/revc.ini");
				Module.FS.createDataFile("/vc-assets/local/revc.ini", 0, revc_ini, revc_ini
					.length);
			} catch (e) {
				console.error('mainCalled error:', e);
			}
		},
		syncRevcIni: () => {
			try {
				const path = Module.FS.lookupPath("/vc-assets/local/revc.ini");
				if (path && path.node && path.node.contents) {
					localStorage.setItem('vcsky.revc.ini', textDecoder.decode(path.node
						.contents));
				}
			} catch (e) {
				console.error('syncRevcIni error:', e);
			}
		},
		print: (args) => {
			if (args.trim().length === 0) return;
			console.log(args);
		},
		printErr: (args) => {
			if (args.trim().length === 0) return;
			console.error(args);
		},
		getPreloadedPackage: () => {
			return dataBuffer.buffer;
		},
		canvas: function() {
			const canvas = document.getElementById('canvas');
			canvas.addEventListener('webglcontextlost', (e) => {
				statusElement.textContent = 'WebGL context lost. Please reload the page.';
				e.preventDefault();
			});
			return canvas;
		}(),
		setStatus,
		totalDependencies: 0,
		monitorRunDependencies: (num) => {
			Module.totalDependencies = Math.max(Module.totalDependencies, num);
			Module.setStatus(
				`Preparing... (${Module.totalDependencies - num}/${Module.totalDependencies})`);
		},
		hotelMission: () => {
			if (!haveOriginalGame) {
				const wastedContainer = document.querySelector('.wasted-container');
				wastedContainer.hidden = false;
				alert(t("cantContinuePlaying"));
				throw new Error(t("cantContinuePlaying"));
			}
		},
		instantiateWasm: async (info, receiveInstance) => {
			const module = await WebAssembly.instantiate(wasm_data, info);
			return receiveInstance(module.instance, module);
		},
		arguments: window.location.search.slice(1).split('&').filter(Boolean).map(decodeURIComponent),
		// 禁用自动退出运行时（浏览器环境必需）
		noExitRuntime: true
	};
	// Module.log = Module.print;
	window.onerror = (message) => {
		Module.setStatus(`Error: ${message}`);
		spinnerElement.hidden = true;
	};
	window.onbeforeunload = (event) => {
		event.preventDefault();
		return '';
	};
	// 加载核心JS
	let modules = [
		'./modules/runtime.js',
		(currentLanguage === 'ru' ? './modules/packages/ru.js' : './modules/packages/en.js'),
		'./modules/loader.js',
		'./modules/fs.js',
		'./modules/audio.js',
		'./modules/graphics.js',
		'./modules/events.js',
		'./modules/fetch.js',
		(currentLanguage === 'ru' ? './modules/asm_consts/ru.js' :
			'./modules/asm_consts/en.js'),
		'./modules/main.js'
	];
	if (cheatsEnabled) modules.push('./modules/cheats.js');
	if (typeof importScripts === 'function') {
		importScripts.apply(null, modules);
	} else {
		const loadNext = (i) => {
			if (i < modules.length) {
				const s = document.createElement('script');
				s.defer = true;
				s.src = modules[i];
				s.onload = () => {
					loadNext(i + 1);
				};
				s.onerror = () => {
					console.error('Failed to load module: ' + modules[i]);
				};
				document.body.appendChild(s);
			}
		};
		loadNext(0);
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
	])
	spinnerElement.hidden = true;
	introContainer.style.cursor = 'pointer';
	intro.pause();
	introContainer.style.display = 'none';
}
clickToPlay.addEventListener('click', (e) => {
	if (!haveOriginalGame) {
		alert(t('demoOffDisclaimer'));
		return;
	}
	if (e.target === clickToPlay || e.target === clickToPlay.querySelector('button')) {
		startGame(e);
		if (!isMobile && autoFullScreen) {
			if (window.top === window) {
				document.body.requestFullscreen(document.documentElement);
			} else {
				window.top.postMessage({
					event: 'request-fullscreen',
				}, '*');
			}
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
	} else if (window.top !== window) {
		window.top.postMessage({
			event: 'request-fullscreen',
		}, '*');
	}
});
const savesMountPoint = "/vc-assets/local/userfiles";
const savesFile = "vcsky.saves";
wrapIDBFS(console.log).addListener({
	onLoad: (_, mount) => {
		if (mount.mountpoint !== savesMountPoint) {
			return null;
		}
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
		if (mount.mountpoint !== savesMountPoint) {
			return;
		}
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
const disclaimerCheckbox = document.getElementById('disclaimer-checkbox');
const originalGameFile = document.getElementById('original-game-file');
const ownerShipConfirmed = () => {
	localStorage.setItem('vcsky.haveOriginalGame', 'true');
	disclaimerCheckbox.checked = true;
	clickToPlayButton.textContent = t('clickToPlayFull');
	demoOffDisclaimer.textContent = "";
	clickToPlayButton.classList.remove('disabled');
	haveOriginalGame = true;
};
const ownerShipNotConfirmed = () => {
	localStorage.removeItem('vcsky.haveOriginalGame');
	disclaimerCheckbox.checked = false;
	clickToPlayButton.textContent = t('clickToPlayDemo');
	demoOffDisclaimer.textContent = "* " + t('demoOffDisclaimer');
	haveOriginalGame = false;
	clickToPlayButton.classList.add('disabled');
};
disclaimerCheckbox.addEventListener('change', async (inputEvent) => {
	if (inputEvent.target.checked) {
		if (confirm(t('disclaimerPrompt'))) {
			originalGameFile.addEventListener('change', async (e) => {
				try {
					const file = e.target.files[0];
					if (file) {
						const sha256sums = (await (await fetch("./vcsky/sha256sums.txt"))
							.text()).toLowerCase();
						const arrayBuffer = await file.arrayBuffer();
						if (window.crypto && window.crypto.subtle) {
							const hashBuffer = await window.crypto.subtle.digest('SHA-256',
								arrayBuffer);
							const hashArray = Array.from(new Uint8Array(hashBuffer));
							const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0'))
								.join();
							if (sha256sums.indexOf(hashHex) !== -1) {
								ownerShipConfirmed();
							} else {
								ownerShipNotConfirmed();
							}
						} else {
							ownerShipNotConfirmed();
						}
					} else {
						ownerShipNotConfirmed();
					}
				} catch (error) {
					console.error('Error:', error);
					ownerShipNotConfirmed();
				}
			}, {
				once: true
			});
			originalGameFile.click();
			return;
		}
	}
	ownerShipNotConfirmed();
});
localStorage.getItem('vcsky.haveOriginalGame') === 'true' ? ownerShipConfirmed() : ownerShipNotConfirmed();
// 可配置模式界面
if (configurableMode) {
	const configPanel = document.getElementById('config-panel');
	const configLang = document.getElementById('config-lang');
	const configCheats = document.getElementById('config-cheats');
	const configFullscreen = document.getElementById('config-fullscreen');
	const configMaxFps = document.getElementById('config-max-fps');
	if (configPanel && configCheats && configFullscreen && configMaxFps) {
		// 显示配置面板
		configPanel.style.display = 'block';
		// 从 URL 参数设置初始值
		if (configLang) configLang.value = currentLanguage;
		configCheats.checked = cheatsEnabled;
		configFullscreen.checked = autoFullScreen;
		configMaxFps.value = maxFPS;
		// 使用当前语言更新配置面板标签
		updateAllTranslations();
		// 语言选择处理程序
		if (configLang) {
			configLang.addEventListener('change', (e) => {
				currentLanguage = e.target.value;
				updateGameDataForLanguage(currentLanguage);
				updateAllTranslations();
			});
		}
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
	}
}
/* game核心模块结束 */