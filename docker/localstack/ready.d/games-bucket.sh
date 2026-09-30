#!/bin/bash
# Runs once LocalStack is ready. Terraform makes this bucket in a deployment; here it is made by
# hand, with the two properties @grove/api will not work without.
set -euo pipefail

bucket="${GAMES_BUCKET:-grove-games}"

awslocal s3api create-bucket --bucket "$bucket" >/dev/null

# Versioning is the history rather than a recovery window: a save overwrites a creator's file in
# place and freezes the version id in a manifest, and a bucket that answers no version makes every
# write report `unavailable`.
awslocal s3api put-bucket-versioning \
    --bucket "$bucket" \
    --versioning-configuration Status=Enabled >/dev/null

# An asset's bytes go straight from the browser to the bucket over a presigned PUT, so the two
# origins that hold a logged-in person are the two this has to allow.
awslocal s3api put-bucket-cors --bucket "$bucket" --cors-configuration '{
    "CORSRules": [
        {
            "AllowedMethods": ["GET", "PUT", "HEAD"],
            "AllowedOrigins": ["http://localhost:5175", "http://localhost:5176", "http://localhost:5177"],
            "AllowedHeaders": ["*"],
            "ExposeHeaders": ["ETag", "x-amz-version-id"],
            "MaxAgeSeconds": 300
        }
    ]
}' >/dev/null

echo "games bucket ready: $bucket (versioning on)"
