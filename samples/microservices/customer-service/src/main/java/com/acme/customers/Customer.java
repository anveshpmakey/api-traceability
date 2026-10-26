package com.acme.customers;

import org.springframework.data.mongodb.core.mapping.Document;

@Document(collection = "customers")
public class Customer {
    private String id;
}
