use super::*;

impl FsStore {
    pub fn git_repository_snapshot(&self) -> Result<GitRepositorySnapshot, String> {
        self.read_conn(crate::git_repository::repository_snapshot)
    }

    pub fn list_git_objects(
        &self,
        request: ListGitObjectsRequest,
    ) -> Result<ListGitObjectsResponse, String> {
        let snapshot_change_id = i64::try_from(request.snapshot_change_id)
            .map_err(|_| "snapshot_change_id is too large".to_string())?;
        self.read_conn(|conn| {
            crate::git_repository::list_objects(
                conn,
                snapshot_change_id,
                request.cursor.as_deref(),
                request.limit,
            )
        })
    }

    pub fn read_git_object_chunk(
        &self,
        request: ReadGitObjectChunkRequest,
    ) -> Result<Option<GitObjectChunk>, String> {
        let snapshot_change_id = i64::try_from(request.snapshot_change_id)
            .map_err(|_| "snapshot_change_id is too large".to_string())?;
        self.read_conn(|conn| {
            crate::git_repository::read_object_chunk(
                conn,
                snapshot_change_id,
                &request.oid,
                request.offset,
                request.limit,
            )
        })
    }
}
