import { describe, it, expect } from "vitest";
import {
    parseSsdpResponse,
    parseDeviceDescription,
    buildDidlLite,
    buildSoapEnvelope,
    parseSoapResponse,
    parseUpnpTime,
    formatUpnpTime,
    escapeXml,
} from "./dlna";

const SSDP_OK = [
    "HTTP/1.1 200 OK",
    "CACHE-CONTROL: max-age=1800",
    "LOCATION: http://192.168.100.50:9197/dmr",
    "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
    "USN: uuid:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d::urn:schemas-upnp-org:device:MediaRenderer:1",
    "",
    "",
].join("\r\n");

const DEVICE_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>[TV] Odyssey OLED G8</friendlyName>
    <manufacturer>Samsung Electronics</manufacturer>
    <modelName>LS34DG850SUXDU</modelName>
    <UDN>uuid:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/upnp/control/AVTransport1</controlURL>
        <eventSubURL>/upnp/event/AVTransport1</eventSubURL>
        <SCPDURL>/AVTransport1.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;

describe("parseSsdpResponse", () => {
    it("extracts LOCATION/ST/USN from a 200 response", () => {
        const r = parseSsdpResponse(SSDP_OK);
        expect(r).toEqual({
            location: "http://192.168.100.50:9197/dmr",
            st: "urn:schemas-upnp-org:device:MediaRenderer:1",
            usn: "uuid:0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d::urn:schemas-upnp-org:device:MediaRenderer:1",
        });
    });
    it("rejects NOTIFY / non-200 / missing LOCATION", () => {
        expect(parseSsdpResponse("NOTIFY * HTTP/1.1\r\nLOCATION: http://x/\r\n\r\n")).toBeNull();
        expect(parseSsdpResponse("HTTP/1.1 404 Not Found\r\nLOCATION: http://x/\r\n\r\n")).toBeNull();
        expect(parseSsdpResponse("HTTP/1.1 200 OK\r\nST: foo\r\n\r\n")).toBeNull();
    });
});

describe("parseDeviceDescription", () => {
    it("resolves the AVTransport controlURL against the LOCATION and strips uuid:", () => {
        const d = parseDeviceDescription(DEVICE_XML, "http://192.168.100.50:9197/dmr");
        expect(d).not.toBeNull();
        expect(d!.udn).toBe("0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d");
        expect(d!.friendlyName).toBe("[TV] Odyssey OLED G8");
        expect(d!.modelName).toBe("LS34DG850SUXDU");
        expect(d!.controlUrl).toBe("http://192.168.100.50:9197/upnp/control/AVTransport1");
    });
    it("honours URLBase when present", () => {
        const xml = DEVICE_XML.replace("<device>", "<URLBase>http://10.0.0.9:8080/</URLBase><device>");
        const d = parseDeviceDescription(xml, "http://192.168.100.50:9197/dmr");
        expect(d!.controlUrl).toBe("http://10.0.0.9:8080/upnp/control/AVTransport1");
    });
    it("returns null for devices without AVTransport", () => {
        const xml = DEVICE_XML.replace(/<service>\s*<serviceType>urn:schemas-upnp-org:service:AVTransport[\s\S]*?<\/service>/, "");
        expect(parseDeviceDescription(xml, "http://x/")).toBeNull();
    });
});

describe("buildDidlLite", () => {
    it("emits a video item with protocolInfo, escaped URL and subtitle res", () => {
        const url = "http://192.168.1.5:17899/video/direct/f1?t=a&u=b";
        const didl = buildDidlLite(url, { title: "Dune <Part 2>", mime: "video/mp4", subtitleUrl: "http://192.168.1.5:17899/video/subs/f1/0?t=a&u=b" });
        expect(didl).toContain("<upnp:class>object.item.videoItem.movie</upnp:class>");
        expect(didl).toContain("<dc:title>Dune &lt;Part 2&gt;</dc:title>");
        expect(didl).toContain(`<res protocolInfo="http-get:*:video/mp4:*">http://192.168.1.5:17899/video/direct/f1?t=a&amp;u=b</res>`);
        expect(didl).toContain(`<sec:CaptionInfoEx sec:type="vtt">`);
        expect(didl).not.toContain("?t=a&u=b"); // raw ampersand must be escaped
    });
    it("picks the audio class from an audio/* mime", () => {
        const didl = buildDidlLite("http://h/a.mp3", { title: "Song", mime: "audio/mpeg" });
        expect(didl).toContain("object.item.audioItem.musicTrack");
        expect(didl).not.toContain("CaptionInfoEx");
    });
});

describe("SOAP helpers", () => {
    it("builds a SetAVTransportURI envelope with InstanceID 0", () => {
        const env = buildSoapEnvelope("SetAVTransportURI", { CurrentURI: "http://h/x?a=1&b=2", CurrentURIMetaData: "<DIDL-Lite/>" });
        expect(env).toContain(`<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">`);
        expect(env).toContain("<InstanceID>0</InstanceID>");
        expect(env).toContain("<CurrentURI>http://h/x?a=1&amp;b=2</CurrentURI>");
        expect(env).toContain("<CurrentURIMetaData>&lt;DIDL-Lite/&gt;</CurrentURIMetaData>");
    });
    it("parses GetPositionInfo response fields", () => {
        const xml = `<s:Envelope><s:Body><u:GetPositionInfoResponse><Track>1</Track><TrackDuration>1:45:10</TrackDuration><RelTime>0:12:34</RelTime><TrackURI>http://h/x?a=1&amp;b=2</TrackURI></u:GetPositionInfoResponse></s:Body></s:Envelope>`;
        const r = parseSoapResponse(xml);
        expect(r.TrackURI).toBe("http://h/x?a=1&b=2");
        expect(parseUpnpTime(r.RelTime)).toBe(754);
        expect(parseUpnpTime(r.TrackDuration)).toBe(6310);
        expect(parseUpnpTime("NOT_IMPLEMENTED")).toBeNull();
    });
    it("round-trips upnp time", () => {
        expect(formatUpnpTime(6310)).toBe("1:45:10");
        expect(formatUpnpTime(0)).toBe("0:00:00");
        expect(escapeXml(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
    });
});
