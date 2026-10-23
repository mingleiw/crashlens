package com.acme;

public class App {
    public static void main(String[] args) {
        Registry registry = new Registry();
        registry.register(EventType.ORDER_PLACED, p -> "placed " + p);
        registry.register(EventType.ORDER_SHIPPED, p -> "shipped " + p);
        registry.register(EventType.REFUND_ISSUED, p -> "refund " + p);

        Dispatcher dispatcher = new Dispatcher(registry);
        // Event types arrive in the wire format the producers use.
        System.out.println(dispatcher.dispatch("order.shipped", "{\"id\": 4417}"));
    }
}
