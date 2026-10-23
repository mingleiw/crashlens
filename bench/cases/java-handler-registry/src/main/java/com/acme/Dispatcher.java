package com.acme;

public class Dispatcher {
    private final Registry registry;

    public Dispatcher(Registry registry) {
        this.registry = registry;
    }

    public String dispatch(String wireType, String payload) {
        Handler handler = registry.forType(wireType);
        // Unknown event types come from newer producers; there is no
        // handler for them yet, so they should be dropped quietly.
        return handler.handle(payload);
    }
}
