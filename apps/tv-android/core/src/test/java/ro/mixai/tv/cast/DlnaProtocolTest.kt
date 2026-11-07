package ro.mixai.tv.cast

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DlnaProtocolTest {

    private val samsungDescription = """
        <?xml version="1.0"?>
        <root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:sec="http://www.sec.co.kr/dlna" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
          <specVersion><major>1</major><minor>0</minor></specVersion>
          <device>
            <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
            <pnpx:X_compatibleId xmlns:pnpx="http://schemas.microsoft.com/windows/pnpx/2005/11">MS_DigitalMediaDeviceClass_DMR_V001</pnpx:X_compatibleId>
            <dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
            <friendlyName>[TV] Samsung Odyssey G8 &amp; Co</friendlyName>
            <manufacturer>Samsung Electronics</manufacturer>
            <manufacturerURL>http://www.samsung.com/sec</manufacturerURL>
            <modelName>LS34BG850S</modelName>
            <UDN>uuid:0d5a1b2c-00c8-1000-b4f1-f8e61a2b3c4d</UDN>
            <iconList>
              <icon><mimetype>image/jpeg</mimetype><width>48</width><height>48</height><depth>24</depth><url>/dmr/icon_SML.jpg</url></icon>
              <icon><mimetype>image/jpeg</mimetype><width>120</width><height>120</height><depth>24</depth><url>/dmr/icon_LRG.jpg</url></icon>
              <icon><mimetype>image/png</mimetype><width>48</width><height>48</height><depth>24</depth><url>/dmr/icon_SML.png</url></icon>
              <icon><mimetype>image/bmp</mimetype><width>512</width><height>512</height><depth>24</depth><url>/dmr/icon_HUGE.bmp</url></icon>
            </iconList>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
                <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
                <controlURL>/upnp/control/RenderingControl1</controlURL>
                <eventSubURL>/upnp/event/RenderingControl1</eventSubURL>
                <SCPDURL>/RenderingControl_1.xml</SCPDURL>
              </service>
              <service>
                <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
                <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
                <controlURL>/upnp/control/ConnectionManager1</controlURL>
                <eventSubURL>/upnp/event/ConnectionManager1</eventSubURL>
                <SCPDURL>/ConnectionManager_1.xml</SCPDURL>
              </service>
              <service>
                <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
                <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
                <controlURL>/upnp/control/AVTransport1</controlURL>
                <eventSubURL>/upnp/event/AVTransport1</eventSubURL>
                <SCPDURL>/AVTransport_1.xml</SCPDURL>
              </service>
            </serviceList>
            <sec:ProductCap>Y2023,WebURIPlayable,NavigateInPause,ScreenMirroringP2PMAC=f8:e6:1a:2b:3c:4d</sec:ProductCap>
          </device>
        </root>
    """.trimIndent()

    private val urlBaseDescription = """
        <?xml version="1.0" encoding="utf-8"?>
        <root xmlns="urn:schemas-upnp-org:device-1-0">
          <URLBase>http://192.168.1.50:1400/</URLBase>
          <device>
            <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
            <friendlyName>Living Room - Sonos One</friendlyName>
            <manufacturer>Sonos, Inc.</manufacturer>
            <modelName>Sonos One</modelName>
            <UDN>uuid:RINCON_000E58AABBCC01400</UDN>
            <deviceList>
              <device>
                <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
                <friendlyName>Living Room - Sonos One Media Renderer</friendlyName>
                <manufacturer>Sonos, Inc.</manufacturer>
                <modelName>Sonos One</modelName>
                <UDN>uuid:RINCON_000E58AABBCC01400_MR</UDN>
                <iconList><icon><mimetype>image/png</mimetype><width>48</width><height>48</height><depth>24</depth><url>img/icon-S1.png</url></icon></iconList>
                <serviceList>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
                    <controlURL>/MediaRenderer/RenderingControl/Control</controlURL>
                  </service>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType>
                    <controlURL>MediaRenderer/AVTransport/Control</controlURL>
                  </service>
                </serviceList>
              </device>
            </deviceList>
          </device>
        </root>
    """.trimIndent()

    private val mediaServerDescription = """
        <?xml version="1.0"?>
        <root xmlns="urn:schemas-upnp-org:device-1-0">
          <device>
            <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
            <friendlyName>NAS Media Server</friendlyName>
            <UDN>uuid:4d696e69-444c-164e-9d41-001132aabbcc</UDN>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
                <controlURL>/ctl/ContentDir</controlURL>
              </service>
              <service>
                <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
                <controlURL>/ctl/ConnectionMgr</controlURL>
              </service>
            </serviceList>
          </device>
        </root>
    """.trimIndent()

    @Test
    fun samsungDescriptionResolvesRelativeUrlsAgainstLocation() {
        val r = DlnaProtocol.parseDeviceDescription(samsungDescription, "http://192.168.1.23:9197/dmr")
        assertNotNull(r)
        r!!
        assertEquals("0d5a1b2c-00c8-1000-b4f1-f8e61a2b3c4d", r.udn)
        assertEquals("[TV] Samsung Odyssey G8 & Co", r.name)
        assertEquals("Samsung Electronics", r.manufacturer)
        assertEquals("LS34BG850S", r.model)
        assertEquals("http://192.168.1.23:9197/dmr", r.location)
        assertEquals("http://192.168.1.23:9197/upnp/control/AVTransport1", r.avTransportUrl)
        assertEquals("http://192.168.1.23:9197/upnp/control/RenderingControl1", r.renderingControlUrl)
        assertEquals("http://192.168.1.23:9197/upnp/control/ConnectionManager1", r.connectionManagerUrl)
        // Largest PNG/JPEG icon; the bigger BMP is ignored.
        assertEquals("http://192.168.1.23:9197/dmr/icon_LRG.jpg", r.iconUrl)
        assertEquals("urn:schemas-upnp-org:service:AVTransport:1", r.avTransportUrn)
    }

    @Test
    fun urlBaseWinsAndEmbeddedRendererDeviceIsUsed() {
        val r = DlnaProtocol.parseDeviceDescription(urlBaseDescription, "http://192.168.1.50:1400/xml/device_description.xml")!!
        assertEquals("RINCON_000E58AABBCC01400_MR", r.udn)
        assertEquals("Living Room - Sonos One Media Renderer", r.name)
        assertEquals("http://192.168.1.50:1400/MediaRenderer/AVTransport/Control", r.avTransportUrl)
        assertEquals("http://192.168.1.50:1400/MediaRenderer/RenderingControl/Control", r.renderingControlUrl)
        assertNull(r.connectionManagerUrl)
        assertEquals("http://192.168.1.50:1400/img/icon-S1.png", r.iconUrl)
        assertEquals("urn:schemas-upnp-org:service:AVTransport:2", r.avTransportUrn)
    }

    @Test
    fun descriptionWithoutAvTransportIsNull() {
        assertNull(DlnaProtocol.parseDeviceDescription(mediaServerDescription, "http://192.168.1.10:8200/rootDesc.xml"))
    }

    @Test
    fun ssdpOkResponseYieldsLocationOthersDoNot() {
        val ok = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nDATE: Sat, 07 Nov 2026 10:00:00 GMT\r\nEXT:\r\n" +
            "LOCATION: http://192.168.1.23:9197/dmr\r\nSERVER: SHP, UPnP/1.0, Samsung UPnP SDK/1.0\r\n" +
            "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:0d5a::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
        assertEquals("http://192.168.1.23:9197/dmr", DlnaProtocol.parseSsdpResponse(ok))
        assertNull(DlnaProtocol.parseSsdpResponse(ok.replace("200 OK", "404 Not Found")))
        assertNull(DlnaProtocol.parseSsdpResponse("HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\n\r\n"))
        assertNull(DlnaProtocol.parseSsdpResponse(DlnaProtocol.mSearch()))
    }

    @Test
    fun ssdpNotifyAliveForMediaRendererIsAccepted() {
        val alive = "NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nLOCATION: http://192.168.1.77:49152/description.xml\r\n" +
            "NT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nNTS: ssdp:alive\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
        assertEquals("http://192.168.1.77:49152/description.xml", DlnaProtocol.parseSsdpResponse(alive))
        assertNull(DlnaProtocol.parseSsdpResponse(alive.replace("ssdp:alive", "ssdp:byebye")))
        assertNull(DlnaProtocol.parseSsdpResponse(alive.replace("device:MediaRenderer:1", "device:MediaServer:1")))
    }

    @Test
    fun soapEnvelopePutsInstanceIdFirstAndEscapesArgs() {
        val env = DlnaProtocol.soapEnvelope(
            "urn:schemas-upnp-org:service:RenderingControl:1", "SetVolume",
            listOf("Channel" to "Master", "DesiredVolume" to "35"),
        )
        assertTrue(env.contains("<u:SetVolume xmlns:u=\"urn:schemas-upnp-org:service:RenderingControl:1\"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>35</DesiredVolume></u:SetVolume>"))
        assertTrue(env.startsWith("<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope"))
        val withMeta = DlnaProtocol.soapEnvelope(DlnaProtocol.AVTRANSPORT_URN, "SetAVTransportURI",
            listOf("CurrentURI" to "http://h/a?x=1&y=2", "CurrentURIMetaData" to "<DIDL-Lite/>"))
        assertTrue(withMeta.contains("<CurrentURI>http://h/a?x=1&amp;y=2</CurrentURI>"))
        assertTrue(withMeta.contains("<CurrentURIMetaData>&lt;DIDL-Lite/&gt;</CurrentURIMetaData>"))
    }

    @Test
    fun getPositionInfoResponseDecodesNestedDidl() {
        val xml = """<?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
            <s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
            <Track>1</Track><TrackDuration>0:03:45</TrackDuration>
            <TrackMetaData>&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;&lt;item&gt;&lt;dc:title&gt;Rock &amp;amp; Roll&lt;/dc:title&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</TrackMetaData>
            <TrackURI>http://192.168.1.5:17899/api/music/stream/42?t=a&amp;b=c</TrackURI>
            <RelTime>0:01:02.500</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>2147483647</RelCount><AbsCount>2147483647</AbsCount>
            </u:GetPositionInfoResponse></s:Body></s:Envelope>"""
        val m = DlnaProtocol.parseSoapResponse(xml)
        assertEquals("0:03:45", m["TrackDuration"])
        assertEquals("http://192.168.1.5:17899/api/music/stream/42?t=a&b=c", m["TrackURI"])
        assertEquals(62_500L, DlnaProtocol.parseTime(m["RelTime"]))
        assertEquals(225_000L, DlnaProtocol.parseTime(m["TrackDuration"]))
        assertNull(DlnaProtocol.parseTime(m["AbsTime"]))
        val meta = m["TrackMetaData"]!!
        assertTrue(meta.startsWith("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\">"))
        assertTrue(meta.contains("<dc:title>Rock &amp; Roll</dc:title>"))
        assertNull(DlnaProtocol.soapFault(xml))
    }

    @Test
    fun getTransportInfoAndGetVolumeResponses() {
        val transport = """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
            <u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
            <CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>
            </u:GetTransportInfoResponse></s:Body></s:Envelope>"""
        val t = DlnaProtocol.parseSoapResponse(transport)
        assertEquals("PAUSED_PLAYBACK", t["CurrentTransportState"])
        assertEquals("OK", t["CurrentTransportStatus"])
        val volume = """<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
            <u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><CurrentVolume>17</CurrentVolume></u:GetVolumeResponse>
            </s:Body></s:Envelope>"""
        assertEquals("17", DlnaProtocol.parseSoapResponse(volume)["CurrentVolume"])
    }

    @Test
    fun upnpFaultExposesCodeAndDescription() {
        val fault = """<?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
            <s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
            <detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail>
            </s:Fault></s:Body></s:Envelope>"""
        assertEquals("701: Transition not available", DlnaProtocol.soapFault(fault))
        assertEquals(701, DlnaProtocol.soapFaultCode(fault))
        val bare = "<s:Envelope><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>Internal Error</faultstring></s:Fault></s:Body></s:Envelope>"
        assertEquals("Internal Error", DlnaProtocol.soapFault(bare))
        assertNull(DlnaProtocol.soapFaultCode(bare))
    }

    @Test
    fun timeParseAndFormat() {
        assertEquals(0L, DlnaProtocol.parseTime("0:00:00"))
        assertEquals(3_723_000L, DlnaProtocol.parseTime("1:02:03"))
        assertEquals(3_723_045L, DlnaProtocol.parseTime("01:02:03.045"))
        assertEquals(5_100L, DlnaProtocol.parseTime("0:00:05.1"))
        assertEquals(36_000_000L, DlnaProtocol.parseTime("10:00:00"))
        assertNull(DlnaProtocol.parseTime("NOT_IMPLEMENTED"))
        assertNull(DlnaProtocol.parseTime(""))
        assertNull(DlnaProtocol.parseTime(null))
        assertNull(DlnaProtocol.parseTime("1:75:00"))
        assertNull(DlnaProtocol.parseTime("abc"))
        assertEquals("0:00:00", DlnaProtocol.formatTime(0))
        assertEquals("0:00:00", DlnaProtocol.formatTime(-500))
        assertEquals("0:03:45", DlnaProtocol.formatTime(225_999))
        assertEquals("1:02:03", DlnaProtocol.formatTime(3_723_000))
        assertEquals("12:00:01", DlnaProtocol.formatTime(43_201_000))
    }

    @Test
    fun didlEscapesTitlesAndCarriesMusicTrackFields() {
        val didl = DlnaProtocol.didlLite(
            "http://192.168.1.5:17899/api/music/stream/7?a=1&b=2",
            DlnaMeta(title = "Tom & Jerry <Live>", artist = "AC/DC & \"Friends\"", album = "Back in Black",
                albumArtUrl = "http://h/art.jpg?s=600&f=png", mime = "audio/flac", durationMs = 225_400),
        )
        assertTrue(didl.contains("<dc:title>Tom &amp; Jerry &lt;Live&gt;</dc:title>"))
        assertTrue(didl.contains("<upnp:class>object.item.audioItem.musicTrack</upnp:class>"))
        assertTrue(didl.contains("<upnp:artist>AC/DC &amp; &quot;Friends&quot;</upnp:artist>"))
        assertTrue(didl.contains("<dc:creator>AC/DC &amp; &quot;Friends&quot;</dc:creator>"))
        assertTrue(didl.contains("<upnp:album>Back in Black</upnp:album>"))
        assertTrue(didl.contains("<upnp:albumArtURI>http://h/art.jpg?s=600&amp;f=png</upnp:albumArtURI>"))
        assertTrue(didl.contains(
            "<res protocolInfo=\"http-get:*:audio/flac:DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000\" duration=\"0:03:45.000\">" +
                "http://192.168.1.5:17899/api/music/stream/7?a=1&amp;b=2</res>",
        ))
        assertFalse(didl.contains("Tom & Jerry"))
        // Optional fields are omitted when unknown.
        val minimal = DlnaProtocol.didlLite("http://h/x.mp3", DlnaMeta("A", null, null, null, "audio/mpeg", null))
        assertFalse(minimal.contains("duration="))
        assertFalse(minimal.contains("upnp:artist"))
        assertFalse(minimal.contains("albumArtURI"))
    }

    @Test
    fun sinkProtocolInfoParsesHttpGetMimes() {
        val sink = "http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01, http-get:*:audio/L16;rate=44100;channels=2:DLNA.ORG_PN=LPCM," +
            "http-get:*:AUDIO/FLAC:*,rtsp-rtp-udp:*:video/mp4:*,http-get:*:audio/x-ms-wma:*,http-get:*:audio/mpeg:*,,garbage"
        val mimes = DlnaProtocol.parseSinkProtocolInfo(sink)
        assertEquals(setOf("audio/mpeg", "audio/l16;rate=44100;channels=2", "audio/flac", "audio/x-ms-wma"), mimes)
        assertTrue(DlnaProtocol.parseSinkProtocolInfo("").isEmpty())
    }

    @Test
    fun xmlEscapeAndDecodeRoundTrip() {
        val raw = "a & b < c > d \"e\" 'f' ș"
        val escaped = DlnaProtocol.escapeXml(raw)
        assertEquals("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos; ș", escaped)
        assertEquals(raw, DlnaProtocol.decodeXml(escaped))
        assertEquals("A&B é", DlnaProtocol.decodeXml("&#65;&amp;&#x42; &#233;"))
        // Double-escaped stays single-decoded (no cascade).
        assertEquals("&lt;", DlnaProtocol.decodeXml("&amp;lt;"))
    }
}
