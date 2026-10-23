package com.acme;

import java.util.HashMap;
import java.util.Map;

public class Registry {
    private final Map<String, Handler> handlers = new HashMap<>();

    public void register(EventType type, Handler handler) {
        handlers.put(type.name(), handler);
    }

    public Handler forType(String wireType) {
        return handlers.get(wireType);
    }
}
