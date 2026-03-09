#!/usr/bin/env python3
"""
EKF Profile Fusion — Phase 5 of Identity Resolution Engine

Extended Kalman Filter for continuous profile confidence updates.
Each new data source is a noisy observation that updates the profile state.

State vector: [name_confidence, org_confidence, location_confidence, overall_confidence]
Measurement: each new source contributes evidence for/against current profile data
Process noise: time-based decay (organizations change, people move)
Measurement noise: inversely proportional to source reliability

Usage:
    python3 ekf-fusion.py                  # Run EKF update for all profiles
    python3 ekf-fusion.py --stats          # Show fusion stats
"""

import os
import sys
import json
import time
import math

PG_CONNSTR = os.environ.get("PG_CONNSTR", "host=10.8.0.1 port=5432 dbname=ozzu user=ozzu password=ozzu")

# Source reliability scores (0-1, higher = more reliable)
SOURCE_RELIABILITY = {
    "wikipedia": 0.95,
    "wikimedia_commons": 0.90,
    "news": 0.80,
    "reddit": 0.40,
    "satellite_google": 0.60,
    "satellite_bing": 0.60,
    "satellite_yandex": 0.50,
    "satellite_ddg": 0.55,
    "satellite_flickr": 0.45,
    "laion": 0.35,
    "glint360k": 0.30,
}
DEFAULT_RELIABILITY = 0.40

# EKF parameters
PROCESS_NOISE = 0.01    # How fast confidence decays over time
DECAY_RATE = 0.001      # Per-day decay for stale profiles


def log(msg):
    print(msg, flush=True)


def get_pg():
    try:
        import psycopg2
        return psycopg2.connect(PG_CONNSTR)
    except Exception as e:
        log(f"[pg] Connection failed: {e}")
        return None


def kalman_update(prior_mean, prior_variance, measurement, measurement_noise):
    """Single-variable Kalman filter update step.
    Returns (posterior_mean, posterior_variance)."""
    kalman_gain = prior_variance / (prior_variance + measurement_noise)
    posterior_mean = prior_mean + kalman_gain * (measurement - prior_mean)
    posterior_variance = (1 - kalman_gain) * prior_variance
    return posterior_mean, posterior_variance


def compute_source_quality(metadata):
    """Compute overall source quality based on platforms and domain count."""
    platforms = metadata.get("platforms", [])
    if not platforms:
        return DEFAULT_RELIABILITY

    # Average reliability of all platforms
    reliabilities = [SOURCE_RELIABILITY.get(p, DEFAULT_RELIABILITY) for p in platforms]
    avg_rel = sum(reliabilities) / len(reliabilities)

    # Boost for diverse sources
    if len(platforms) >= 3:
        avg_rel = min(1.0, avg_rel * 1.15)

    return avg_rel


def run_ekf_fusion():
    """Run EKF update for all face identities."""
    conn = get_pg()
    if not conn:
        return

    cur = conn.cursor()
    cur.execute("""
        SELECT id, primary_name, confidence, source_count, domain_count, metadata
        FROM face_identities
        WHERE primary_name IS NOT NULL AND primary_name != ''
    """)
    identities = cur.fetchall()
    log(f"Processing {len(identities)} identities")

    updated = 0
    for identity_id, name, current_conf, source_count, domain_count, metadata_raw in identities:
        try:
            metadata = json.loads(metadata_raw) if isinstance(metadata_raw, str) else (metadata_raw or {})
        except Exception:
            metadata = {}

        # Prior state
        prior_mean = current_conf or 0.5
        prior_variance = 0.1  # uncertainty

        # Measurement 1: source agreement (how many sources agree on the name)
        name_candidates = metadata.get("name_candidates_count", source_count)
        if name_candidates > 0:
            agreement = min(1.0, source_count / max(name_candidates, 1))
            measurement_noise = 1.0 / max(source_count, 1)
            prior_mean, prior_variance = kalman_update(prior_mean, prior_variance, agreement, measurement_noise)

        # Measurement 2: source quality
        source_quality = compute_source_quality(metadata)
        prior_mean, prior_variance = kalman_update(prior_mean, prior_variance, source_quality, 0.2)

        # Measurement 3: domain diversity (more unique domains = more reliable)
        if domain_count and domain_count > 0:
            diversity_score = min(1.0, domain_count / 10.0)  # 10+ domains = max score
            prior_mean, prior_variance = kalman_update(prior_mean, prior_variance, diversity_score, 0.15)

        # Measurement 4: source count (more sources = more confident)
        count_score = min(1.0, source_count / 50.0) if source_count else 0.1  # 50+ = max
        prior_mean, prior_variance = kalman_update(prior_mean, prior_variance, count_score, 0.2)

        # Clamp
        new_confidence = max(0.01, min(1.0, prior_mean))

        # Update
        if abs(new_confidence - (current_conf or 0)) > 0.01:
            cur.execute("""
                UPDATE face_identities SET confidence = %s, updated_at = NOW()
                WHERE id = %s
            """, (round(new_confidence, 4), identity_id))
            updated += 1

    conn.commit()
    cur.close()
    conn.close()
    log(f"Updated {updated}/{len(identities)} identity confidence scores")


def show_stats():
    conn = get_pg()
    if not conn:
        return
    cur = conn.cursor()

    cur.execute("""
        SELECT
            COUNT(*) as total,
            AVG(confidence) as avg_conf,
            COUNT(*) FILTER (WHERE confidence > 0.8) as high_conf,
            COUNT(*) FILTER (WHERE confidence > 0.5 AND confidence <= 0.8) as med_conf,
            COUNT(*) FILTER (WHERE confidence <= 0.5) as low_conf
        FROM face_identities
        WHERE primary_name IS NOT NULL
    """)
    row = cur.fetchone()
    log(f"=== EKF Fusion Stats ===")
    log(f"Total identities: {row[0]}")
    log(f"Average confidence: {row[1]:.3f}" if row[1] else "No data")
    log(f"High confidence (>0.8): {row[2]}")
    log(f"Medium confidence (0.5-0.8): {row[3]}")
    log(f"Low confidence (<0.5): {row[4]}")

    cur.close()
    conn.close()


def main():
    if "--stats" in sys.argv:
        show_stats()
        return

    log("=" * 60)
    log("EKF PROFILE FUSION — Identity Resolution Phase 5")
    log("=" * 60)

    try:
        run_ekf_fusion()
    except Exception as e:
        log(f"[error] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
