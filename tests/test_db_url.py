import pytest

from ingest.db import _check_url


def test_direct_host_rejected():
    with pytest.raises(RuntimeError, match="Session pooler"):
        _check_url("postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres")


def test_pooler_and_local_ok():
    _check_url("postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres")
    _check_url("postgresql://postgres@/bsb_test?host=/tmp&port=5499")


def test_py_adapts_lists_and_dicts():
    from psycopg.types.json import Jsonb

    from ingest.db import _py

    assert _py(["a", "b"]) == ["a", "b"]            # text[] stays a list
    assert isinstance(_py({"k": 1}), Jsonb)          # dict → jsonb
    assert isinstance(_py([{"k": 1}]), Jsonb)        # list of dicts → jsonb
    assert _py(None) is None
