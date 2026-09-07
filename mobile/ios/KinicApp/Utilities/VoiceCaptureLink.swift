// Where: mobile/ios/KinicApp/Utilities/VoiceCaptureLink.swift
// What: Stable universal links for system voice capture entry points.
// Why: Widgets, Shortcuts, and app URL routing must use one public contract.

import Foundation

enum VoiceCaptureLink {
    static func url(mode: VoiceCaptureMode) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "wiki.kinic.xyz"
        components.path = "/ios-voice-capture"
        components.queryItems = [URLQueryItem(name: "mode", value: mode.rawValue)]
        return components.url!
    }
}
