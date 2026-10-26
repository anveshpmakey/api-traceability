package com.acme.orders.api;

public record CreateOrderRequest(String customerId, String sku, int quantity, long amountCents) {}
