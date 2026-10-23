package com.acme;

import java.math.BigDecimal;

public class InvoiceService {
    private final CustomerRepository customers;

    public InvoiceService(CustomerRepository customers) {
        this.customers = customers;
    }

    public String invoiceLine(Order order) {
        Customer customer = customers.find(order.email());
        // Guest checkouts have no customer record and no tier yet; a missing
        // tier should fall back to the standard rate.
        String tier = customer.tier();
        BigDecimal rate = "gold".equals(tier) ? new BigDecimal("0.90") : BigDecimal.ONE;
        return order.id() + ": " + order.amount().multiply(rate);
    }
}
