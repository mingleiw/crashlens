package com.acme;

import java.math.BigDecimal;

public record Order(String id, String email, BigDecimal amount) {}
