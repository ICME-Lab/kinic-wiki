package xyz.kinic.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.AbstractVisitor
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MarkdownTextNode
import org.commonmark.parser.Parser

@Composable
internal fun KinicMarkdown(markdown: String, onOpenLink: ((String) -> Unit)? = null) {
    val rendered = remember(markdown) { parseKinicMarkdown(markdown) }
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(rendered.text, style = MaterialTheme.typography.bodyLarge)
            if (onOpenLink != null) {
                rendered.links.forEach { link ->
                    AssistChip(
                        onClick = { onOpenLink(link) },
                        label = { Text(link) },
                        leadingIcon = { Icon(Icons.Outlined.Language, contentDescription = null) },
                    )
                }
            }
        }
    }
}

private data class KinicMarkdownContent(val text: AnnotatedString, val links: List<String>)

private fun parseKinicMarkdown(markdown: String): KinicMarkdownContent {
    val parser = Parser.builder()
        .extensions(listOf(TablesExtension.create(), StrikethroughExtension.create(), AutolinkExtension.create()))
        .build()
    val links = mutableListOf<String>()
    val text = buildAnnotatedString {
        parser.parse(markdown).accept(object : AbstractVisitor() {
            override fun visit(textNode: MarkdownTextNode) { append(textNode.literal) }
            override fun visit(code: Code) {
                val start = length
                append(code.literal)
                addStyle(SpanStyle(fontWeight = FontWeight.Medium), start, length)
            }
            override fun visit(codeBlock: FencedCodeBlock) {
                append(codeBlock.literal.trimEnd())
                append('\n')
            }
            override fun visit(softLineBreak: SoftLineBreak) { append('\n') }
            override fun visit(hardLineBreak: HardLineBreak) { append('\n') }
            override fun visit(strongEmphasis: StrongEmphasis) {
                val start = length
                visitChildren(strongEmphasis)
                addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, length)
            }
            override fun visit(emphasis: Emphasis) {
                val start = length
                visitChildren(emphasis)
                addStyle(SpanStyle(fontStyle = FontStyle.Italic), start, length)
            }
            override fun visit(heading: Heading) {
                val start = length
                visitChildren(heading)
                addStyle(
                    SpanStyle(
                        fontWeight = FontWeight.Bold,
                        fontSize = if (heading.level <= 2) 22.sp else 18.sp,
                    ),
                    start,
                    length,
                )
                append('\n')
            }
            override fun visit(paragraph: Paragraph) {
                visitChildren(paragraph)
                append("\n\n")
            }
            override fun visit(listItem: ListItem) {
                append("• ")
                visitChildren(listItem)
                append('\n')
            }
            override fun visit(link: Link) {
                visitChildren(link)
                links += link.destination
            }
        })
    }
    return KinicMarkdownContent(text, links.distinct())
}
