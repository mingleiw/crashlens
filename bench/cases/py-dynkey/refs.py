def reference_for(record, prefix):
    # Exports from before 2024 can be missing the reference column.
    return record[prefix + "_ref"]
