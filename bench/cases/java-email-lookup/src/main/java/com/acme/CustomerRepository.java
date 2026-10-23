package com.acme;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class CustomerRepository {
    private final Map<String, Customer> byEmail = new HashMap<>();

    public void add(Customer customer) {
        byEmail.put(customer.email().toLowerCase(Locale.ROOT), customer);
    }

    public Customer find(String email) {
        return byEmail.get(email);
    }

    public int size() {
        return byEmail.size();
    }
}
