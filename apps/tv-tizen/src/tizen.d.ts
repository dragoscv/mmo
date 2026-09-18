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

interface TizenWebAPIError { name: string; message: string; code?: number }
interface TizenAppInfo { id: string; name: string; version?: string; installDate?: Date }
interface TizenApplicationControlData { key: string; value: string[] }
interface TizenApplicationControl {
    operation: string;
    uri: string | null;
    mime: string | null;
    category: string | null;
    data: TizenApplicationControlData[];
}
interface TizenApplicationControlDataCtor { new (key: string, value: string[]): TizenApplicationControlData }
interface TizenApplicationControlCtor {
    new (operation: string, uri?: string | null, mime?: string | null, category?: string | null, data?: TizenApplicationControlData[] | null): TizenApplicationControl;
}
interface TizenApplicationManager {
    getCurrentApplication(): TizenApplication;
    getAppInfo(id?: string): TizenAppInfo;
    launchAppControl(
        control: TizenApplicationControl,
        id?: string | null,
        onSuccess?: () => void,
        onError?: (e: TizenWebAPIError) => void,
        replyCallback?: unknown,
    ): void;
}

interface TizenNamespace {
    tvinputdevice?: TizenTvInputDevice;
    application?: TizenApplicationManager;
    ApplicationControl?: TizenApplicationControlCtor;
    ApplicationControlData?: TizenApplicationControlDataCtor;
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
