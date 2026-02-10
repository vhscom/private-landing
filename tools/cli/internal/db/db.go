package db

import (
	"database/sql"
	"fmt"

	_ "github.com/tursodatabase/libsql-client-go/libsql"
)

// Open connects to a Turso/libSQL database using the provided URL and auth token.
func Open(url, authToken string) (*sql.DB, error) {
	dsn := fmt.Sprintf("%s?authToken=%s", url, authToken)
	return sql.Open("libsql", dsn)
}
