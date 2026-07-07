// Where: mobile/ios/KinicApp/Views/MarkdownBlockParser.swift
// What: Conservative block parser for common Kinic Wiki Markdown.
// Why: The iOS app needs readable native previews while avoiding renderer dependencies and broad Markdown compatibility code.

import Foundation

struct MarkdownBlockParser {
    func parse(_ markdown: String) -> [MarkdownBlock] {
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]

            if line.trimmedForMarkdown.isEmpty {
                index += 1
            } else if let fenced = parseCodeBlock(lines: lines, startIndex: index) {
                blocks.append(.codeBlock(language: fenced.language, code: fenced.code))
                index = fenced.nextIndex
            } else if let heading = parseHeading(line) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
            } else if isDivider(line) {
                blocks.append(.divider)
                index += 1
            } else if let quoted = parseQuote(lines: lines, startIndex: index) {
                blocks.append(.quote(quoted.text))
                index = quoted.nextIndex
            } else if let list = parseBulletList(lines: lines, startIndex: index) {
                blocks.append(.bulletList(list.items))
                index = list.nextIndex
            } else if let list = parseNumberedList(lines: lines, startIndex: index) {
                blocks.append(.numberedList(list.items))
                index = list.nextIndex
            } else {
                let paragraph = parseParagraph(lines: lines, startIndex: index)
                blocks.append(.paragraph(paragraph.text))
                index = paragraph.nextIndex
            }
        }

        return blocks
    }

    private func parseCodeBlock(lines: [String], startIndex: Int) -> (language: String?, code: String, nextIndex: Int)? {
        let trimmed = lines[startIndex].trimmedForMarkdown
        guard trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") else {
            return nil
        }

        let fence = String(trimmed.prefix(3))
        let language = nonEmpty(String(trimmed.dropFirst(3)).trimmedForMarkdown)
        var codeLines: [String] = []
        var index = startIndex + 1

        while index < lines.count {
            if lines[index].trimmedForMarkdown.hasPrefix(fence) {
                return (language, codeLines.joined(separator: "\n"), index + 1)
            }
            codeLines.append(lines[index])
            index += 1
        }

        return (language, codeLines.joined(separator: "\n"), index)
    }

    private func parseHeading(_ line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmedForMarkdown
        var level = 0

        for character in trimmed {
            if character == "#" {
                level += 1
            } else {
                break
            }
        }

        guard (1...6).contains(level) else {
            return nil
        }
        let markerEnd = trimmed.index(trimmed.startIndex, offsetBy: level)
        guard markerEnd < trimmed.endIndex,
              trimmed[markerEnd].isWhitespace else {
            return nil
        }

        let text = String(trimmed[markerEnd...]).trimmedForMarkdown
        guard !text.isEmpty else {
            return nil
        }
        return (level, text)
    }

    private func isDivider(_ line: String) -> Bool {
        let trimmed = line.trimmedForMarkdown
        guard trimmed.count >= 3 else {
            return false
        }
        let characters = Set(trimmed.filter { !$0.isWhitespace })
        return characters == ["-"] || characters == ["*"] || characters == ["_"]
    }

    private func parseQuote(lines: [String], startIndex: Int) -> (text: String, nextIndex: Int)? {
        guard let first = parseQuoteLine(lines[startIndex]) else {
            return nil
        }

        var quoteLines = [first]
        var index = startIndex + 1

        while index < lines.count {
            guard let line = parseQuoteLine(lines[index]) else {
                break
            }
            quoteLines.append(line)
            index += 1
        }

        return (quoteLines.joined(separator: "\n"), index)
    }

    private func parseQuoteLine(_ line: String) -> String? {
        let trimmed = line.trimmedForMarkdown
        guard trimmed.hasPrefix(">") else {
            return nil
        }
        return String(trimmed.dropFirst()).trimmedForMarkdown
    }

    private func parseBulletList(lines: [String], startIndex: Int) -> (items: [String], nextIndex: Int)? {
        guard let first = parseBulletItem(lines[startIndex]) else {
            return nil
        }

        var items = [first]
        var index = startIndex + 1

        while index < lines.count {
            guard let item = parseBulletItem(lines[index]) else {
                break
            }
            items.append(item)
            index += 1
        }

        return (items, index)
    }

    private func parseBulletItem(_ line: String) -> String? {
        let trimmed = line.trimmedForMarkdown
        for marker in ["- ", "* ", "+ "] {
            if trimmed.hasPrefix(marker) {
                return String(trimmed.dropFirst(marker.count)).trimmedForMarkdown
            }
        }
        return nil
    }

    private func parseNumberedList(lines: [String], startIndex: Int) -> (items: [String], nextIndex: Int)? {
        guard let first = parseNumberedItem(lines[startIndex]) else {
            return nil
        }

        var items = [first]
        var index = startIndex + 1

        while index < lines.count {
            guard let item = parseNumberedItem(lines[index]) else {
                break
            }
            items.append(item)
            index += 1
        }

        return (items, index)
    }

    private func parseNumberedItem(_ line: String) -> String? {
        let trimmed = line.trimmedForMarkdown
        guard let dotIndex = trimmed.firstIndex(of: ".") else {
            return nil
        }

        let number = trimmed[..<dotIndex]
        guard !number.isEmpty,
              number.allSatisfy(\.isNumber) else {
            return nil
        }

        let afterDot = trimmed.index(after: dotIndex)
        guard afterDot < trimmed.endIndex,
              trimmed[afterDot].isWhitespace else {
            return nil
        }

        return String(trimmed[afterDot...]).trimmedForMarkdown
    }

    private func parseParagraph(lines: [String], startIndex: Int) -> (text: String, nextIndex: Int) {
        var paragraphLines: [String] = []
        var index = startIndex

        while index < lines.count {
            let line = lines[index]
            if line.trimmedForMarkdown.isEmpty || isBlockStart(line) {
                break
            }
            paragraphLines.append(line.trimmedForMarkdown)
            index += 1
        }

        return (paragraphLines.joined(separator: "\n"), index)
    }

    private func isBlockStart(_ line: String) -> Bool {
        parseCodeBlock(lines: [line], startIndex: 0) != nil
            || parseHeading(line) != nil
            || isDivider(line)
            || parseQuoteLine(line) != nil
            || parseBulletItem(line) != nil
            || parseNumberedItem(line) != nil
    }

    private func nonEmpty(_ value: String) -> String? {
        value.isEmpty ? nil : value
    }
}

private extension String {
    var trimmedForMarkdown: String {
        trimmingCharacters(in: .whitespaces)
    }
}
