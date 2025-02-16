#!/usr/bin/env -S sh -euo pipefail
#
# Database backup script
# Creates timestamped backups of the Turso database
#
# Features:
# - Timestamped backups in tar.gz format
# - Automatic cleanup of old backups
# - Error handling and cleanup on failure
#
# @license LGPL-3.0-or-later

# Configuration variables
DB_NAME="private-landing-db" # Database to backup
MAX_BACKUPS=10               # Number of backups to retain

# Start backup process
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting database backup..."

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

# Create temporary directory for work
TIMESTAMP=$(date '+%Y-%m-%d-%H%M%S')
BACKUP_NAME="backup-$TIMESTAMP"
TEMP_DIR=$(mktemp -d)
BACKUP_FILE="src/db/backups/$BACKUP_NAME.tar.gz"

mkdir -p src/db/backups

# Dump database to temp directory
echo "Dumping database..."
if ! echo ".dump" |
	turso db shell "$DB_NAME" 2>/dev/null |
	grep -v "Connecting to database" >"$TEMP_DIR/database.sql"; then
	echo "Error: Database dump command failed"
	rm -rf "$TEMP_DIR"
	exit 1
fi

if [ -s "$TEMP_DIR/database.sql" ]; then
	# Check if dump contains error message
	if grep -q "not logged in" "$TEMP_DIR/database.sql"; then
		echo "Error: Authentication failed. Please run 'turso auth login' first"
		rm -rf "$TEMP_DIR"
		exit 1
	fi

	echo "Database dump size: $(wc -c <"$TEMP_DIR/database.sql") bytes"
	echo "Database dump first few lines:"
	head -n 5 "$TEMP_DIR/database.sql"

	# Create compressed archive with flattened structure
	tar -czf "$BACKUP_FILE" -C "$TEMP_DIR" .
	rm -rf "$TEMP_DIR"
	echo "Backup created successfully: $BACKUP_FILE"
	echo "Backup size: $(wc -c <"$BACKUP_FILE") bytes"

	# Rotate old backups
	find src/db/backups -name "backup-*.tar.gz" -type f | sort -r |
		tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f 2>/dev/null || true

	echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup complete"
else
	echo "Error: Database dump failed or is empty"
	rm -rf "$TEMP_DIR"
	exit 1
fi
