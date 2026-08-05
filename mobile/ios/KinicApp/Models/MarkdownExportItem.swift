// Where: mobile/ios/KinicApp/Models/MarkdownExportItem.swift
// What: Transferable Markdown file for the native share sheet.
// Why: Export should send a real .md file instead of flattening the document into shared text.

import CoreTransferable
import Foundation
import UniformTypeIdentifiers

struct MarkdownExportItem: Transferable, Sendable {
    let fileName: String
    let content: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .kinicMarkdown) { item in
            let directory = FileManager.default.temporaryDirectory
                .appending(path: "KinicMarkdownExports", directoryHint: .isDirectory)
                .appending(path: UUID().uuidString, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let fileURL = directory.appending(path: item.fileName, directoryHint: .notDirectory)
            try Data(item.content.utf8).write(to: fileURL, options: .atomic)
            return SentTransferredFile(fileURL)
        }
    }
}

private extension UTType {
    static let kinicMarkdown = UTType(importedAs: "net.daringfireball.markdown", conformingTo: .plainText)
}
