package com.acme.orders.domain;

import jakarta.persistence.*;

@Entity
@Table(name = "orders")
public class Order {
    @Id @GeneratedValue
    private Long id;
    private String customerId;
    private String sku;
    private int quantity;
    private String status;
}
