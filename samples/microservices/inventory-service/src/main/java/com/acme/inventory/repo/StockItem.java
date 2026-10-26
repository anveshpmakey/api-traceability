package com.acme.inventory.repo;

import jakarta.persistence.Entity;
import jakarta.persistence.Table;

@Entity
@Table(name = "stock_items")
public class StockItem {
    private String sku;
    private int quantity;
    public int getQuantity() { return quantity; }
}
