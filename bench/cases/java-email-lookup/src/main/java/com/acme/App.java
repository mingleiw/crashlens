package com.acme;

import java.math.BigDecimal;

public class App {
    public static void main(String[] args) {
        CustomerRepository customers = new CustomerRepository();
        customers.add(new Customer("dana.lee@example.com", "Dana Lee", "gold"));
        customers.add(new Customer("sam.ortiz@example.com", "Sam Ortiz", "standard"));

        InvoiceService invoices = new InvoiceService(customers);
        Order order = new Order("A-1001", "Dana.Lee@Example.com", new BigDecimal("120.00"));
        System.out.println(invoices.invoiceLine(order));
    }
}
