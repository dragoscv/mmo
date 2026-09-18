// Minimal ambient typings for the Tizen TV web APIs we touch.
// Both globals are injected by the platform ($WEBAPIS/webapis/webapis.js);
// they are undefined when the bundle runs in a desktop browser.

interface TizenInputDeviceKey { name: string; code: number }

interface TizenTvInputDevice {
    registerKey(name: string): void;
    unregisterKey(name: string): void;
    getSupportedKeys(): TizenInputDeviceKey[];
    getKey(name: string): TizenInputDeviceKey | null;
}

interface TizenApplication { exit(): void; hide(): void }

interface TizenNamespace {
    tvinputdevice?: TizenTvInputDevice;
    application?: { getCurrentApplication(): TizenApplication };
}

interface WebApisProductInfo { getModel(): string; getFirmware(): string; getVersion(): string }
interface WebApisNetwork {
    getIp(): string;
    getSubnetMask?(): string;
    getGateway?(): string;
    isConnectedToGateway?(): boolean;
}
interface WebApisNamespace { productinfo?: WebApisProductInfo; network?: WebApisNetwork }

declare const tizen: TizenNamespace | undefined;
declare const webapis: WebApisNamespace | undefined;
