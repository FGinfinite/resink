#!/bin/bash
# Wait for MongoDB to be ready before running the init script

set -e

# Start MongoDB in the background
mongod --replSet overleaf --bind_ip_all &
MONGOD_PID=$!

# Wait for MongoDB to start accepting connections
echo "Waiting for MongoDB to start..."
for i in {1..30}; do
    if mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
        echo "MongoDB is ready"
        break
    fi
    echo "Waiting... ($i/30)"
    sleep 1
done

# Run the init script if MongoDB is ready
if mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    # Initialize replica set
    mongosh --eval 'rs.initiate({_id: "overleaf", members: [{_id: 0, host: "mongo:27017"}]})' 2>/dev/null || true
    echo "Replica set initialized"
fi

# Wait for mongod to exit
wait $MONGOD_PID
