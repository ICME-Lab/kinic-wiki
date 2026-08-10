package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AskAiProtocolTest {
    @Test
    fun queryParserNormalizesWidthDeduplicatesAndEnforcesLimits() {
        val plan = AskAiQueryPlanner.parse(
            """

            <answer>
            Ｋｉｎｉｃ　Wiki
            kinic wiki
            日本語 検索
            </answer>
            """.trimIndent(),
        )

        assertEquals(listOf("kinic wiki", "日本語 検索"), plan.queries.map { it.text })
        assertThrows(IllegalArgumentException::class.java) {
            AskAiQueryPlanner.parse("<answer>one two three four five</answer>")
        }
    }

    @Test
    fun ranksRepeatedPathsBeforeLowerSingleQueryScores() {
        val plan = AskAiQueryPlan(
            listOf(
                AskAiQueryPlan.Query("alpha", listOf("alpha")),
                AskAiQueryPlan.Query("beta", listOf("beta")),
            ),
        )
        val shared = hit("/shared.md", 5f)
        val ranked = AskAiRetrievalPlanner.rankedCandidates(
            plan,
            mapOf(
                "alpha" to listOf(hit("/single.md", 0.1f), shared),
                "beta" to listOf(shared.copy(score = 4f)),
            ),
        )

        assertEquals("/shared.md", ranked.first().hit.path)
        assertEquals(2, ranked.first().matchedQueryCount)
    }

    @Test
    fun exactTokenVerificationRejectsSubstringOnlyMatches() {
        val plan = AskAiQueryPlan(listOf(AskAiQueryPlan.Query("猫", listOf("猫"))))

        assertTrue(AskAiRetrievalPlanner.hasRequiredExactMatches(plan, "猫 は小動物です"))
        assertFalse(AskAiRetrievalPlanner.hasRequiredExactMatches(plan, "猫舌について説明します"))
    }

    @Test
    fun promptRespectsGlobalAndPerSourceLimits() {
        val sources = (1..8).map { index ->
            AskAiContextSource(
                AskAiSource("S$index", "/$index.md", "excerpt", 1f, emptyList()),
                "x".repeat(10_000),
            )
        }

        val prompt = AskAiPromptBuilder.build("Knowledge", "Question", emptyList(), sources)

        assertTrue(prompt.message.length <= AskAiPromptBuilder.MAXIMUM_MESSAGE_CHARACTERS)
        assertTrue(prompt.includedContexts.size <= AskAiRetrievalPlanner.MAXIMUM_SOURCES)
        assertTrue(prompt.includedContexts.all {
            it.content.length <= AskAiRetrievalPlanner.MAXIMUM_CONTEXT_CHARACTERS_PER_SOURCE ||
                it.content.length == 10_000
        })
    }

    @Test
    fun responseDecoderRequiresKnownUniqueSourcesAndStrictTagOrder() {
        assertEquals(
            AskAiResponseOutcome.Supported(listOf("S1"), "Answer"),
            AskAiResponseDecoder.decode(
                "<sources>S1</sources>\n<answer>Answer</answer>",
                setOf("S1", "S2"),
            ),
        )
        assertEquals(
            AskAiResponseOutcome.Insufficient,
            AskAiResponseDecoder.decode("<sources></sources><answer></answer>", setOf("S1")),
        )
        assertThrows(IllegalArgumentException::class.java) {
            AskAiResponseDecoder.decode("<answer>Answer</answer><sources>S1</sources>", setOf("S1"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AskAiResponseDecoder.decode("<sources>S9</sources><answer>Answer</answer>", setOf("S1"))
        }
    }

    private fun hit(path: String, score: Float): SearchNodeHit =
        SearchNodeHit(
            path = path,
            kind = VfsNodeKind.FILE,
            snippet = null,
            previewExcerpt = null,
            matchReasons = emptyList(),
            score = score,
        )
}
