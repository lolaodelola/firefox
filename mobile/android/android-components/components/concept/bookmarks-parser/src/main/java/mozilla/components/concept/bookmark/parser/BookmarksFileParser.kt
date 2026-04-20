/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.concept.bookmark.parser

import mozilla.components.concept.storage.bookmarks.InsertableBookmarkNode

/**
 * An abstract definition of a component that parses bookmark files into a tree of
 * [InsertableBookmarkNode]s.
 */
fun interface BookmarksFileParser {

    /**
     * Parses the given [uri] and returns the root of the resulting [InsertableBookmarkNode] tree.
     *
     * @param uri The raw bytes of the bookmark file to parse.
     * @return A [Result] containing the root [InsertableBookmarkNode] of the parsed tree,
     * or a failure if the file could not be parsed.
     */
    suspend fun parse(uri: String): Result<InsertableBookmarkNode>

    companion object {

        /**
         * Returns a [BookmarksFileParser] that always succeeds, returning [tree] if provided
         * or a default tree otherwise.
         */
        fun fakeSuccess(tree: InsertableBookmarkNode?): BookmarksFileParser =
            FakeSuccessParser(tree)

        /**
         * Returns a [BookmarksFileParser] that always fails with a [BookmarksFileParser].
         */
        fun fakeFailure() = BookmarksFileParser {
            Result.failure(RuntimeException("couldn't parse it"))
        }
    }
}

private class FakeSuccessParser(val returnedTree: InsertableBookmarkNode?) : BookmarksFileParser {
    override suspend fun parse(uri: String): Result<InsertableBookmarkNode> = Result.success(
        returnedTree ?: defaultFakeSuccessTree,
    )

    private val defaultFakeSuccessTree: InsertableBookmarkNode = InsertableBookmarkNode.Folder(
        title = "Bookmarks",
        position = 0u,
        dateAddedTimestamp = 0L,
        lastModifiedTimestamp = 0L,
        children = listOf(
            InsertableBookmarkNode.Folder(
                parentGuid = "1234",
                title = "Subfolder",
                position = 0u,
                dateAddedTimestamp = 0L,
                lastModifiedTimestamp = 0L,
                children = listOf(
                    InsertableBookmarkNode.Item(
                        parentGuid = "12345",
                        title = "Example",
                        url = "https://example.com",
                        position = 1u,
                        dateAddedTimestamp = 0L,
                        lastModifiedTimestamp = 0L,
                    ),
                    InsertableBookmarkNode.Separator(
                        position = 2u,
                    ),
                    InsertableBookmarkNode.Item(
                        parentGuid = "12345",
                        title = "Wikipedia",
                        url = "https://wikipedia.org",
                        position = 2u,
                        dateAddedTimestamp = 0L,
                        lastModifiedTimestamp = 0L,
                    ),
                ),
            ),
            InsertableBookmarkNode.Item(
                title = "Mozilla",
                url = "https://www.mozilla.org",
                position = 1u,
                dateAddedTimestamp = 0L,
                lastModifiedTimestamp = 0L,
                parentGuid = "1234",
            ),
        ),
        parentGuid = "1234",
    )
}
