#!/usr/bin/env -S sh -euo pipefail
#
# Safe database migration script
# Creates backup before migration and provides restore path if needed
#
# Features:
# - Pre-migration backup in tar.gz format
# - Automatic authentication check
# - Clear restore instructions on failure
#
# @license Apache-2.0

# Configuration variables
DB_NAME="private-landing-db" # Database to backup

# Start migration process
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting safe migration..."

# Check Turso authentication
echo "Checking Turso authentication..."
if ! turso db list >/dev/null 2>&1; then
	echo "Error: Not authenticated with Turso. Please run 'turso auth login' first"
	exit 1
fi

# Test database connection
echo "Testing database connection..."
if ! turso db show "$DB_NAME" >/dev/null 2>&1; then
	echo "Error: Unable to connect to database '$DB_NAME'"
	exit 1
fi

# Create pre-migration backup
echo "Creating backup before migration..."
TIMESTAMP=$(date '+%Y-%m-%d-%H%M%S')
BACKUP_NAME="pre_migration_backup-$TIMESTAMP"
TEMP_DIR=$(mktemp -d)
BACKUP_FILE="src/db/backups/$BACKUP_NAME.tar.gz"

mkdir -p src/db/backups

# Dump database to temp directory
if ! echo ".dump" | turso db shell "$DB_NAME" 2>/dev/null | grep -v "Connecting to database" >"$TEMP_DIR/database.sql"; then
	echo "Error: Database dump failed"
	rm -rf "$TEMP_DIR"
	exit 1
fi

if [ -s "$TEMP_DIR/database.sql" ]; then
	# Create compressed archive with flattened structure
	tar -czf "$BACKUP_FILE" -C "$TEMP_DIR" .
	rm -rf "$TEMP_DIR"
	echo "Backup created: $BACKUP_FILE"
else
	echo "Error: Database dump is empty"
	rm -rf "$TEMP_DIR"
	exit 1
fi

# Attempt migration
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running migration..."

# Create a temporary file for migration with PRAGMA commands
MIGRATION_FILE=$(mktemp)
{
	echo "PRAGMA foreign_keys=OFF;"
	echo "BEGIN TRANSACTION;"
	cat src/db/migrations/001_password_consolidation.sql
	echo "COMMIT;"
	echo "PRAGMA foreign_keys=ON;"
} >"$MIGRATION_FILE"

if ! turso db shell "$DB_NAME" <"$MIGRATION_FILE" 2>&1 | grep -v "Connecting to database"; then
	echo "Error: Migration failed!"
	echo ""
	echo "To restore from backup:"
	echo "1. cd src/db/backups"
	echo "2. tar -xzf $BACKUP_NAME.tar.gz"
	echo "3. turso db shell $DB_NAME < database.sql"
	echo "4. rm -f database.sql"
	rm -f "$MIGRATION_FILE"
	exit 1
fi

rm -f "$MIGRATION_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Migration completed successfully"
