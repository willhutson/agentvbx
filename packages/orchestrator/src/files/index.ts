export {
  LocalFileStore,
  ObsidianStore,
  CloudFileStore,
  FileStoreManager,
} from './store.js';

export type {
  FileEntry,
  FileContent,
  FileStore,
  FileStoreType,
  FileStoreConfig,
  ObsidianNote,
  CloudAdapterLike,
} from './store.js';

export { VersionManager } from './versioning.js';

export type {
  ArtifactStatus,
  ArtifactVersion,
  FeedbackType,
  FeedbackFragment,
  UnifiedFeedback,
  VersionedArtifact,
} from './versioning.js';
