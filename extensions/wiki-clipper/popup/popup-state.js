// Where: extensions/wiki-clipper/popup/popup-state.js
// What: Pure settings-state helpers for first-run database creation.
// Why: Popup DOM code needs small testable rules for the no-database path.
export const DEFAULT_DATABASE_NAME = "My Kinic Wiki";

export function databaseOptionLabel(database, sameNameCount = 1) {
  const databaseId = String(database?.databaseId || database?.database_id || "").trim();
  const name = String(database?.name || "").trim();
  const role = databaseRoleLabel(database?.role);
  const suffixes = [];
  if (role) suffixes.push(role);
  if (!name || sameNameCount > 1) suffixes.push(shortDatabaseId(databaseId));
  return suffixes.length > 0 ? `${name || databaseId} (${suffixes.join(", ")})` : name;
}

export function mergePreferredDatabase(databases, preferredDatabase) {
  const preferredDatabaseId = String(preferredDatabase?.databaseId || preferredDatabase?.database_id || "").trim();
  const role = databaseRoleLabel(preferredDatabase?.role);
  const status = databaseStatusLabel(preferredDatabase?.status);
  if (!preferredDatabaseId || databases.some((database) => database.databaseId === preferredDatabaseId)) {
    return databases;
  }
  if (status !== "Active" || (role !== "Owner" && role !== "Writer")) {
    return databases;
  }
  return [
    ...databases,
    {
      databaseId: preferredDatabaseId,
      name: String(preferredDatabase.name || preferredDatabaseId),
      role,
      status,
      logicalSizeBytes: String(preferredDatabase.logicalSizeBytes || preferredDatabase.logical_size_bytes || "0")
    }
  ];
}

export function shouldShowCreateDatabaseForm({ isAuthenticated, writableDatabaseCount }) {
  return Boolean(isAuthenticated) && writableDatabaseCount === 0;
}

export function validateCreateDatabaseName(value) {
  const name = String(value || "").trim();
  if (!name) {
    throw new Error("Database name is required.");
  }
  return name;
}

function shortDatabaseId(databaseId) {
  if (databaseId.length <= 14) return databaseId;
  return `${databaseId.slice(0, 10)}...`;
}

function databaseRoleLabel(role) {
  if (typeof role === "string") return role.trim();
  if (role && typeof role === "object") return Object.keys(role)[0] || "";
  return "";
}

function databaseStatusLabel(status) {
  if (typeof status === "string") return status.trim();
  if (status && typeof status === "object") return Object.keys(status)[0] || "";
  return "";
}
