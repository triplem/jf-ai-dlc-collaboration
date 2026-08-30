#!/bin/bash
set -e
# One Postgres instance, separate databases per concern.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE dynamo;
    CREATE DATABASE shim;
EOSQL
