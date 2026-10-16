use super::*;
use vfs_types::{
    LearningPublicationRequest, LearningPublicationResult, NodeHistoryPage, NodeHistoryRequest,
    NodeRevision, NodeRevisionRequest, ScopeRevisionRequest,
};

impl VfsService {
    pub fn scope_revision(
        &self,
        caller: &str,
        request: ScopeRevisionRequest,
    ) -> Result<u64, String> {
        self.with_database_store(
            &request.database_id,
            caller,
            RequiredRole::Reader,
            |store| store.scope_revision(&request.prefix),
        )
    }

    pub fn current_node_revision(
        &self,
        caller: &str,
        request: NodeRevisionRequest,
    ) -> Result<Option<NodeRevision>, String> {
        self.with_database_store(
            &request.database_id,
            caller,
            RequiredRole::Reader,
            |store| store.current_node_revision(&request.path),
        )
    }
    pub fn node_history(
        &self,
        caller: &str,
        request: NodeHistoryRequest,
    ) -> Result<NodeHistoryPage, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.node_history(request)
        })
    }
    pub fn publish_learning(
        &self,
        caller: &str,
        request: LearningPublicationRequest,
        now: i64,
    ) -> Result<LearningPublicationResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let paths = request
            .targets
            .iter()
            .filter(|item| item.kind == NodeKind::Source)
            .map(|item| item.path.clone())
            .collect::<Vec<_>>();
        let path_refs = paths.iter().map(String::as_str).collect::<Vec<_>>();
        let result = self.with_detached_node_publications_outcome(
            &database_id,
            caller,
            &path_refs,
            |store, operation_id| {
                store.publish_learning_with_publication_outcome(request, now, operation_id)
            },
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }
}
